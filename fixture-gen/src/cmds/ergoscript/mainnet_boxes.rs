//! Mainnet box ErgoTree corpus.
//!
//! **Status: deferred.** This module is wired into the generator pipeline
//! so that adding box data later is purely a JSON drop-in, but for now no
//! pre-cached mainnet boxes are bundled. We need a JSON file at
//! `fixture-gen/data/ergoscript/mainnet_boxes.json` shaped like:
//!
//! ```json
//! [
//!   {
//!     "box_id": "...",
//!     "ergo_tree_hex": "...",
//!     "block_height": 1234567
//!   },
//!   ...
//! ]
//! ```
//!
//! When that file appears, this generator parses each `ergo_tree_hex` via
//! `ErgoTree::sigma_parse_bytes` to confirm it's well-formed and emits a
//! fixture entry. We avoid the live HTTP fetch on purpose: `cargo run`
//! must be deterministic in CI, and that means no `localhost:9052` calls.
//!
//! See task 29's report for the rationale on why this is the only piece
//! of task 29 deferred — the 45 + 14 + 15 = 74 contract fixtures from
//! `corpus_legacy_45`, `corpus_ecosystem_14`, and `corpus_significant_15`
//! are the load-bearing parity surface.

use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::serialization::SigmaSerializable;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct RawEntry {
    box_id: String,
    ergo_tree_hex: String,
    #[serde(default)]
    block_height: Option<i64>,
}

#[derive(Serialize)]
pub struct CorpusEntry {
    pub box_id: String,
    pub ergo_tree_hex: String,
    pub byte_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_height: Option<i64>,
    /// `true` once the bytes survive a parse + re-serialize cycle (so we
    /// know they're well-formed before TS tests touch them).
    pub round_trip_ok: bool,
}

#[derive(Serialize)]
pub struct CorpusFixture {
    pub corpus: &'static str,
    /// `true` when no `mainnet_boxes.json` data file is present. Lets the TS
    /// harness skip the suite cleanly instead of erroring on an empty entry
    /// list.
    pub deferred: bool,
    pub entries: Vec<CorpusEntry>,
    pub parse_errors: Vec<String>,
}

pub fn generate() -> anyhow::Result<CorpusFixture> {
    let data_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("data")
        .join("ergoscript")
        .join("mainnet_boxes.json");

    if !data_path.exists() {
        return Ok(CorpusFixture {
            corpus: "mainnet_boxes",
            deferred: true,
            entries: Vec::new(),
            parse_errors: Vec::new(),
        });
    }

    let json = std::fs::read_to_string(&data_path)?;
    let raw: Vec<RawEntry> = serde_json::from_str(&json)?;
    let mut entries = Vec::with_capacity(raw.len());
    let mut parse_errors = Vec::new();

    for r in raw {
        let bytes = match hex::decode(&r.ergo_tree_hex) {
            Ok(b) => b,
            Err(e) => {
                parse_errors.push(format!("{}: hex decode failed: {}", r.box_id, e));
                continue;
            }
        };
        let round_trip_ok = match ErgoTree::sigma_parse_bytes(&bytes) {
            Ok(tree) => match tree.sigma_serialize_bytes() {
                Ok(serialized) => serialized == bytes,
                Err(e) => {
                    parse_errors.push(format!("{}: re-serialize failed: {:?}", r.box_id, e));
                    false
                }
            },
            Err(e) => {
                parse_errors.push(format!("{}: parse failed: {:?}", r.box_id, e));
                false
            }
        };
        entries.push(CorpusEntry {
            box_id: r.box_id,
            byte_length: bytes.len(),
            ergo_tree_hex: r.ergo_tree_hex,
            block_height: r.block_height,
            round_trip_ok,
        });
    }

    Ok(CorpusFixture {
        corpus: "mainnet_boxes",
        deferred: false,
        entries,
        parse_errors,
    })
}
