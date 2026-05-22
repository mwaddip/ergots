//! Diagnostic: walk h=1..max-height through the modifier store and log every
//! occurrence (INSERT in outputs, REMOVE in inputs, LOOKUP in data inputs) of
//! a target box_id. Used for phase 2j-pre fix-2 triage of the deterministic
//! `missing-utxo at h=3850` halt.
//!
//! Usage:
//!   walk-trace --store-path PATH --target-box-id HEX [--max-height N]
//!
//! Reuses the shim's `enr-store` + `ergo-lib`/`ergotree-ir` parse path. Does
//! not maintain a UTXO index — purely a streaming scan that logs hits.

use std::env;
use std::io::Cursor;
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use enr_store::{ModifierStore, RedbModifierStore};
use ergo_lib::chain::transaction::Transaction;
use ergo_lib::ergo_chain_types::Header;
use ergotree_ir::serialization::constant_store::ConstantStore;
use ergotree_ir::serialization::sigma_byte_reader::SigmaByteReader;
use ergotree_ir::serialization::SigmaSerializable;
use sigma_ser::vlq_encode::ReadSigmaVlqExt;
use sigma_ser::ScorexSerializable;

const HEADER_TYPE_ID: u8 = 101;
const BLOCK_TRANSACTIONS_TYPE_ID: u8 = 102;
const BLOCK_VERSION_SENTINEL: u32 = 10_000_000;

fn prefixed_hash(prefix: u8, data1: &[u8; 32], data2: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Blake2b::<U32>::new();
    hasher.update([prefix]);
    hasher.update(data1);
    hasher.update(data2);
    let out = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

fn parse_hex32(s: &str) -> Result<[u8; 32]> {
    if s.len() != 64 {
        return Err(anyhow!("box-id hex must be 64 chars, got {}", s.len()));
    }
    let mut out = [0u8; 32];
    for (i, byte_str) in s.as_bytes().chunks(2).enumerate() {
        let hex = std::str::from_utf8(byte_str)?;
        out[i] = u8::from_str_radix(hex, 16)
            .with_context(|| format!("invalid hex byte at offset {}", i * 2))?;
    }
    Ok(out)
}

fn hex_full(id: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in id {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn scan_block(
    store: &RedbModifierStore,
    height: u32,
    target: &[u8; 32],
) -> Result<()> {
    let header_id = match store
        .best_header_at(height)
        .with_context(|| format!("best_header_at({height})"))?
    {
        Some(h) => h,
        None => {
            // Past tip or missing header.
            return Ok(());
        }
    };
    let header_bytes = store
        .read_header_at(height)
        .with_context(|| format!("read_header_at({height})"))?
        .ok_or_else(|| anyhow!("read_header_at({height}) returned None unexpectedly"))?;
    let header = Header::scorex_parse_bytes(&header_bytes).with_context(|| {
        format!("Header::scorex_parse_bytes at height {height}")
    })?;
    let tx_root = header.transaction_root.0;
    let block_txs_id = prefixed_hash(BLOCK_TRANSACTIONS_TYPE_ID, &header_id, &tx_root);
    let block_txs_bytes = store
        .get(BLOCK_TRANSACTIONS_TYPE_ID, &block_txs_id)
        .with_context(|| format!("store.get(102, ...) at h={height}"))?
        .ok_or_else(|| anyhow!("missing BlockTransactions at h={height}"))?;

    if block_txs_bytes.len() < 33 {
        bail!(
            "BlockTransactions at height {height} too short: {} bytes",
            block_txs_bytes.len()
        );
    }
    let embedded_header_id: [u8; 32] = block_txs_bytes[..32]
        .try_into()
        .expect("len-checked above");
    if embedded_header_id != header_id {
        bail!(
            "BlockTransactions header_id mismatch at height {height}"
        );
    }

    let mut cursor = Cursor::new(&block_txs_bytes[32..]);
    let ver_or_count = cursor.get_u32().with_context(|| {
        format!("reading ver_or_count VLQ at h={height}")
    })?;
    let tx_count: usize = if ver_or_count > BLOCK_VERSION_SENTINEL {
        let _block_version = ver_or_count - BLOCK_VERSION_SENTINEL;
        let count = cursor
            .get_u32()
            .with_context(|| format!("reading tx_count VLQ at h={height}"))?;
        count as usize
    } else {
        ver_or_count as usize
    };

    let pos = 32 + cursor.position() as usize;
    let tx_cursor = Cursor::new(&block_txs_bytes[pos..]);
    let mut reader = SigmaByteReader::new(tx_cursor, ConstantStore::empty());

    for tx_idx in 0..tx_count {
        let tx = Transaction::sigma_parse(&mut reader)
            .with_context(|| format!("Transaction::sigma_parse #{tx_idx} at h={height}"))?;
        // Outputs: check each box_id.
        for (out_idx, out) in tx.outputs.iter().enumerate() {
            let id: [u8; 32] = out
                .box_id()
                .as_ref()
                .try_into()
                .expect("BoxId is always 32 bytes");
            if &id == target {
                let bytes = out.sigma_serialize_bytes()?;
                println!(
                    "INSERT  h={height:>6} tx#{tx_idx} out#{out_idx} \
                     box_id={} (sigma_serialize bytes len={})",
                    hex_full(&id),
                    bytes.len()
                );
                println!("        serialized hex: {}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());
            }
        }
        // Inputs: check each referenced box_id.
        for (in_idx, input) in tx.inputs.iter().enumerate() {
            let id: [u8; 32] = input
                .box_id
                .as_ref()
                .try_into()
                .expect("BoxId is always 32 bytes");
            if &id == target {
                println!(
                    "REMOVE  h={height:>6} tx#{tx_idx} in#{in_idx} \
                     box_id={}",
                    hex_full(&id)
                );
                // Dump full tx context: tx_id, all inputs (full box_ids),
                // all output box_ids, output count.
                let tx_id_arr: [u8; 32] = tx.id().0.0;
                println!("        spending tx_id={}", hex_full(&tx_id_arr));
                println!("        tx has {} inputs, {} outputs", tx.inputs.len(), tx.outputs.len());
                for (i, oth_in) in tx.inputs.iter().enumerate() {
                    let oid: [u8; 32] = oth_in.box_id.as_ref().try_into().unwrap();
                    println!("          in #{i}: box_id={}", hex_full(&oid));
                }
                for (i, out) in tx.outputs.iter().enumerate() {
                    let oid: [u8; 32] = out.box_id().as_ref().try_into().unwrap();
                    println!("          out #{i}: box_id={} (value={})", hex_full(&oid), out.value.as_u64());
                }
            }
        }
        // Data inputs.
        let data_inputs_iter = tx
            .data_inputs
            .as_ref()
            .map(|di| di.as_vec().as_slice())
            .unwrap_or(&[]);
        for (di_idx, data_input) in data_inputs_iter.iter().enumerate() {
            let id: [u8; 32] = data_input
                .box_id
                .as_ref()
                .try_into()
                .expect("BoxId is always 32 bytes");
            if &id == target {
                println!(
                    "LOOKUP  h={height:>6} tx#{tx_idx} data_input#{di_idx} \
                     box_id={}",
                    hex_full(&id)
                );
            }
        }
    }

    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut store_path: Option<PathBuf> = None;
    let mut target_hex: Option<String> = None;
    let mut max_height: u32 = 4000;
    let mut start_height: u32 = 1;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--store-path" => {
                store_path = Some(PathBuf::from(args.get(i + 1).ok_or_else(|| {
                    anyhow!("--store-path requires a value")
                })?));
                i += 2;
            }
            "--target-box-id" => {
                target_hex = Some(args.get(i + 1).cloned().ok_or_else(|| {
                    anyhow!("--target-box-id requires a value")
                })?);
                i += 2;
            }
            "--max-height" => {
                max_height = args
                    .get(i + 1)
                    .ok_or_else(|| anyhow!("--max-height requires a value"))?
                    .parse()
                    .context("parsing --max-height")?;
                i += 2;
            }
            "--start-height" => {
                start_height = args
                    .get(i + 1)
                    .ok_or_else(|| anyhow!("--start-height requires a value"))?
                    .parse()
                    .context("parsing --start-height")?;
                i += 2;
            }
            other => return Err(anyhow!("unknown arg: {other}")),
        }
    }
    let store_path = store_path.ok_or_else(|| anyhow!("missing --store-path"))?;
    let target_hex = target_hex.ok_or_else(|| anyhow!("missing --target-box-id"))?;
    let target = parse_hex32(&target_hex)?;

    eprintln!("opening store: {}", store_path.display());
    let store = RedbModifierStore::new(&store_path).context("RedbModifierStore::new")?;
    let header_tip = store
        .tip(HEADER_TYPE_ID)
        .context("store.tip(101)")?
        .map(|(h, _)| h)
        .unwrap_or(0);
    eprintln!("header tip: {header_tip}");
    eprintln!("target box_id: {target_hex}");
    eprintln!("scan range: h={start_height}..{max_height}");
    println!("# walk-trace findings:");

    let end = max_height.min(header_tip);
    for h in start_height..=end {
        if let Err(e) = scan_block(&store, h, &target) {
            eprintln!("scan_block({h}) error: {e:#}");
            return Err(e);
        }
        if h % 500 == 0 {
            eprintln!("... scanned through h={h}");
        }
    }
    eprintln!("done.");
    Ok(())
}
