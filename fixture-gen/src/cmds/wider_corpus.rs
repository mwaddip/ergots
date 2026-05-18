//! Generates `mainnet_boxes_wider.json` — the Task B survey corpus.
//!
//! Two layers:
//! 1. Random recent-window sample (~10,000 boxes from the last 100,000 blocks)
//! 2. Must-include set (5 singleton regression blocks + 700,000-700,050 cost
//!    parity range imported from sigma-rust test vectors).
//!
//! Source: design spec at `docs/specs/2026-05-18-task-b-corpus-widening-design.md`.

use std::collections::HashSet;
use std::fs;

use anyhow::{anyhow, Context, Result};
use rand::{rngs::StdRng, SeedableRng};
use serde::Serialize;
use serde_json::Value;

use ergo_lib::chain::transaction::Transaction;
use ergotree_ir::serialization::SigmaSerializable;

const NODE_URL: &str = "http://127.0.0.1:9052";
const RANDOM_WINDOW_BLOCKS: u32 = 100_000;
const RANDOM_SAMPLE_SIZE: usize = 10_000;
const MUST_INCLUDE_SINGLETONS: &[u32] = &[342_964, 670_557, 680_692, 942_664, 1_711_120];
const COST_PARITY_RANGE_START: u32 = 700_000;
const COST_PARITY_RANGE_END: u32 = 700_050;
const SIGMA_RUST_TX_VECTORS: &str =
    "/home/mwaddip/projects/sigma-rust/sigma-rust/ergo-lib/tests/test-vectors/transactions_700000_700050.json";
// OUTPUT_PATH is constructed at runtime from CARGO_MANIFEST_DIR so the command
// produces the correct path regardless of the working directory from which
// `cargo run` is invoked.  See output_path() below.
const OUTPUT_RELATIVE: &str = "packages/ergoscript/test/fixtures/mainnet_boxes_wider.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    meta: Meta,
    boxes: Vec<BoxEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    generated_at: String,
    node_version: String,
    random_window: RandomWindowMeta,
    must_include_singleton_blocks: Vec<u32>,
    must_include_range: RangeMeta,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RandomWindowMeta {
    start_height: u32,
    end_height: u32,
    seed: String,
}

#[derive(Debug, Serialize)]
struct RangeMeta {
    from: u32,
    to: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoxEntry {
    box_id: String,
    ergo_tree_bytes: String,
    block_height: u32,
    tx_id: String,
    output_index: u32,
    source: String,
}

fn output_path() -> std::path::PathBuf {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // CARGO_MANIFEST_DIR is fixture-gen/; parent is repo root.
    let repo_root = manifest_dir.parent().expect("fixture-gen has a parent directory");
    repo_root.join(OUTPUT_RELATIVE)
}

pub fn run() -> Result<()> {
    // Reuse a single client across all requests for connection pooling.
    let client = reqwest::blocking::Client::new();
    let (tip_height, node_version) = fetch_chain_info(&client)?;
    let (random_sample, random_window_meta) = build_random_sample(&client, tip_height)?;
    let must_include_singletons = build_must_include_singletons(&client)?;
    let must_include_range = build_must_include_cost_parity_range()?;

    // Concatenate (must-include first so dedupe keeps must-include winners).
    let mut boxes: Vec<BoxEntry> = Vec::new();
    boxes.extend(must_include_singletons);
    boxes.extend(must_include_range);
    boxes.extend(random_sample);

    // Dedupe by box_id (preserves earliest occurrence = must-include).
    let mut seen: HashSet<String> = HashSet::new();
    boxes.retain(|b| seen.insert(b.box_id.clone()));

    let box_count = boxes.len();
    let fixture = Fixture {
        meta: Meta {
            generated_at: chrono::Utc::now().to_rfc3339(),
            node_version,
            random_window: random_window_meta,
            must_include_singleton_blocks: MUST_INCLUDE_SINGLETONS.to_vec(),
            must_include_range: RangeMeta {
                from: COST_PARITY_RANGE_START,
                to: COST_PARITY_RANGE_END,
            },
        },
        boxes,
    };

    let out_path = output_path();
    let serialized = serde_json::to_string_pretty(&fixture)?;
    fs::write(&out_path, serialized)
        .with_context(|| format!("writing fixture to {}", out_path.display()))?;
    println!("wrote {} ({} boxes total)", out_path.display(), box_count);
    Ok(())
}

fn fetch_chain_info(client: &reqwest::blocking::Client) -> Result<(u32, String)> {
    let resp: Value = client.get(format!("{}/info", NODE_URL)).send()?.json()?;
    let height = resp
        .get("fullHeight")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| anyhow!("missing fullHeight"))? as u32;
    let version = resp
        .get("appVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Ok((height, version))
}

fn fetch_block(client: &reqwest::blocking::Client, height: u32) -> Result<Value> {
    let header_ids: Vec<String> = client
        .get(format!("{}/blocks/at/{}", NODE_URL, height))
        .send()?
        .json()?;
    let header_id = header_ids
        .first()
        .ok_or_else(|| anyhow!("no block at height {}", height))?;
    let block: Value = client
        .get(format!("{}/blocks/{}", NODE_URL, header_id))
        .send()?
        .json()?;
    Ok(block)
}

fn extract_output_boxes(
    block: &Value,
    height: u32,
    source_for_tx: impl Fn(&str) -> String,
) -> Vec<BoxEntry> {
    let mut out = Vec::new();
    if let Some(Value::Array(txs)) = block.pointer("/blockTransactions/transactions") {
        for tx in txs {
            let tx_id = tx
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let source = source_for_tx(&tx_id);
            if let Some(Value::Array(outputs)) = tx.get("outputs") {
                for (idx, output) in outputs.iter().enumerate() {
                    out.push(BoxEntry {
                        box_id: output
                            .get("boxId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        ergo_tree_bytes: output
                            .get("ergoTree")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        block_height: height,
                        tx_id: tx_id.clone(),
                        output_index: idx as u32,
                        source: source.clone(),
                    });
                }
            }
        }
    }
    out
}

fn build_random_sample(
    client: &reqwest::blocking::Client,
    tip_height: u32,
) -> Result<(Vec<BoxEntry>, RandomWindowMeta)> {
    let start = tip_height.saturating_sub(RANDOM_WINDOW_BLOCKS);
    let end = tip_height;

    let total = end - start + 1;
    let mut pool: Vec<BoxEntry> = Vec::new();
    for height in start..=end {
        let block = fetch_block(client, height)
            .with_context(|| format!("fetching block {}", height))?;
        pool.extend(extract_output_boxes(&block, height, |_| "random".to_string()));
        let done = height - start + 1;
        if done % 10_000 == 0 {
            eprintln!(
                "random sample: {}/{} blocks fetched, {} boxes so far",
                done, total, pool.len()
            );
        }
    }

    let tip_header_ids: Vec<String> = client
        .get(format!("{}/blocks/at/{}", NODE_URL, tip_height))
        .send()?
        .json()?;
    let tip_header_id = tip_header_ids
        .first()
        .ok_or_else(|| anyhow!("no tip block header id"))?;
    let seed_bytes = hex::decode(tip_header_id)?;
    let mut seed: [u8; 32] = [0u8; 32];
    seed[..seed_bytes.len().min(32)].copy_from_slice(&seed_bytes[..seed_bytes.len().min(32)]);
    let mut rng = StdRng::from_seed(seed);

    let n = pool.len().min(RANDOM_SAMPLE_SIZE);
    let indices = rand::seq::index::sample(&mut rng, pool.len(), n);
    let sample: Vec<BoxEntry> = indices.into_iter().map(|i| pool[i].clone()).collect();

    let meta = RandomWindowMeta {
        start_height: start,
        end_height: end,
        seed: format!("0x{}", tip_header_id),
    };
    Ok((sample, meta))
}

fn build_must_include_singletons(client: &reqwest::blocking::Client) -> Result<Vec<BoxEntry>> {
    let mut out = Vec::new();
    for &height in MUST_INCLUDE_SINGLETONS {
        let block = fetch_block(client, height)
            .with_context(|| format!("fetching must-include block {}", height))?;
        let source = match height {
            342_964 => "must-include:pr859-selfboxindex-block-342964",
            670_557 => "must-include:pr857-bigint-modulo-block-670557",
            680_692 => "must-include:pr859-booltosigmaprop-block-680692",
            942_664 => "must-include:pr859-selfboxindex-gating-block-942664",
            1_711_120 => "must-include:pr860-soption-leniency-block-1711120",
            _ => "must-include:unknown",
        }
        .to_string();
        out.extend(extract_output_boxes(&block, height, |_| source.clone()));
    }
    Ok(out)
}

fn build_must_include_cost_parity_range() -> Result<Vec<BoxEntry>> {
    let txs_json = fs::read_to_string(SIGMA_RUST_TX_VECTORS)
        .with_context(|| format!("reading sigma-rust tx vectors at {}", SIGMA_RUST_TX_VECTORS))?;
    let txs: Vec<Value> = serde_json::from_str(&txs_json)?;

    let mut out = Vec::new();
    for tx in txs {
        let tx_id = tx
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let height = tx
            .get("height")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let source = if tx_id.starts_with("518acec") {
            "must-include:pr854-tx-cost-parity:700032:518acec".to_string()
        } else {
            format!("must-include:pr854-tx-cost-parity:{}", height)
        };

        // The sigma-rust test vectors file stores raw serialized transaction bytes
        // in the "bytes" field. Decode and deserialize to extract output boxes.
        let bytes_hex = match tx.get("bytes").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        let tx_bytes = match hex::decode(bytes_hex) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("warn: tx {} hex decode failed: {}", tx_id, e);
                continue;
            }
        };
        let parsed_tx = match Transaction::sigma_parse_bytes(&tx_bytes) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("warn: tx {} parse failed: {:?}", tx_id, e);
                continue;
            }
        };

        for (idx, ergo_box) in parsed_tx.outputs.iter().enumerate() {
            let box_id = format!("{}", ergo_box.box_id());
            let ergo_tree_bytes = match ergo_box.ergo_tree.sigma_serialize_bytes() {
                Ok(b) => hex::encode(b),
                Err(e) => {
                    eprintln!(
                        "warn: tx {} output {} ergo_tree serialize failed: {:?}",
                        tx_id, idx, e
                    );
                    continue;
                }
            };
            out.push(BoxEntry {
                box_id,
                ergo_tree_bytes,
                block_height: height,
                tx_id: tx_id.clone(),
                output_index: idx as u32,
                source: source.clone(),
            });
        }
    }
    Ok(out)
}
