//! Quick diagnostic: open a sidecar UTXO index and query whether a
//! specific box_id is present. Used for phase 2j-pre fix-2 triage of
//! the deterministic `missing-utxo at h=3850` halt.
//!
//! Usage:
//!   cargo run --release --bin sidecar-query -- \
//!     --sidecar-path PATH --box-id HEX
//!
//! Reports presence + first 16 bytes of the box's stored value if found.

use std::env;
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};

// Re-use the shim's UtxoIndex via the library entry. The bin is part of
// the same crate as `src/lib.rs` would be... actually the shim is a
// binary-only crate (no lib.rs). So we'd need to copy/duplicate the
// UtxoIndex constants and table names here, OR add a lib.rs.
//
// Simpler: use redb directly with the same table definitions.

use redb::{Database, ReadableDatabase, ReadableTable, ReadableTableMetadata, TableDefinition};

const BOXES_TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("boxes");
const META_TABLE: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");

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

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    let mut sidecar_path: Option<PathBuf> = None;
    let mut box_id_hex: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--sidecar-path" => {
                sidecar_path = Some(PathBuf::from(args.get(i + 1).ok_or_else(|| {
                    anyhow!("--sidecar-path requires a value")
                })?));
                i += 2;
            }
            "--box-id" => {
                box_id_hex = Some(args.get(i + 1).cloned().ok_or_else(|| {
                    anyhow!("--box-id requires a value")
                })?);
                i += 2;
            }
            other => return Err(anyhow!("unknown arg: {other}")),
        }
    }
    let sidecar_path = sidecar_path.ok_or_else(|| anyhow!("missing --sidecar-path"))?;
    let box_id_hex = box_id_hex.ok_or_else(|| anyhow!("missing --box-id"))?;
    let box_id = parse_hex32(&box_id_hex)?;

    eprintln!("opening sidecar: {}", sidecar_path.display());
    eprintln!("querying box_id: {}", box_id_hex);

    // Use Database::builder().create() like the shim's UtxoIndex does — opening
    // an existing sidecar that was created with the same pattern.
    let db = Database::builder()
        .create(&sidecar_path)
        .context("Database::create")?;
    let txn = db.begin_read().context("begin_read")?;

    // meta table: read indexed_up_to_height marker for context.
    let meta = txn.open_table(META_TABLE).context("open_table meta")?;
    let height_bytes = meta
        .get("indexed_up_to_height")
        .context("meta.get")?
        .ok_or_else(|| anyhow!("meta.indexed_up_to_height not set"))?;
    let height_bytes = height_bytes.value();
    if height_bytes.len() != 4 {
        return Err(anyhow!(
            "indexed_up_to_height has wrong length: {}",
            height_bytes.len()
        ));
    }
    let height_arr: [u8; 4] = height_bytes.try_into().unwrap();
    let height = u32::from_le_bytes(height_arr);
    eprintln!("sidecar indexed_up_to_height: {height}");

    // Total box count in the table.
    let boxes = txn.open_table(BOXES_TABLE).context("open_table boxes")?;
    let count = boxes.len().context("boxes.len")?;
    eprintln!("sidecar boxes table size: {count}");

    // Query the target.
    match boxes.get(box_id.as_slice()).context("boxes.get")? {
        Some(v) => {
            let bytes = v.value();
            eprintln!("FOUND in index — box bytes length: {}", bytes.len());
            let head_len = bytes.len().min(16);
            let head = &bytes[..head_len];
            eprintln!(
                "first {head_len} bytes (hex): {}",
                head.iter().map(|b| format!("{b:02x}")).collect::<String>()
            );
        }
        None => {
            eprintln!("NOT FOUND in index");
        }
    }

    Ok(())
}
