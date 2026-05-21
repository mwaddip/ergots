//! Per-block ingestion logic for the forward-walking UTXO index.
//!
//! For each height `h` between the sidecar's `indexed_up_to_height` and
//! the user-requested target, `ingest_block` reads the header, derives
//! the BlockTransactions / Extension modifier IDs, parses both sections,
//! walks every transaction's outputs into the UTXO index and every input
//! out of it, captures the spent box bytes for emission, and assembles
//! the populated `BlockBundle` that GET_BLOCK will return when
//! `h == target`. The caller discards the intermediate bundles for
//! `h < target` but the sidecar mutation has already happened, so a
//! second GET_BLOCK at the same target starts from `target - 1`.
//!
//! Source-mapping (we re-derive rather than depend on `enr-chain` —
//! see Cargo.toml comment on why):
//! - Modifier-ID derivation: `chain/src/section.rs:60-66`
//!   (`prefixed_hash(prefix, header_id, section_root) =
//!    blake2b256(prefix || header_id || section_root)`).
//! - BlockTransactions wire format (`[header_id: 32B] [ver_or_count: VLQ]
//!   [tx_count: VLQ if ver>1] [txs: Transaction × tx_count]`):
//!   `validation/src/sections.rs:74-122` in the snapshot-sync worktree.
//! - Extension wire format (`[header_id: 32B] [field_count: VLQ]
//!   [fields: { key: 2B, val_len: 1B, value: val_len B } × field_count]`):
//!   `validation/src/sections.rs:125-169` in the snapshot-sync worktree.
//! - Parameter extraction (key[0] == 0x00 → param ID = key[1] as i8;
//!   value is 4-byte BE i32; ID 124 / `SoftForkDisablingRules` is skipped
//!   for variable-length encoding): `chain/src/voting.rs:253-291`.
//!
//! Genesis (height 1): the first block on Ergo. Inputs at height 1 spend
//! the synthetic emission box that exists outside the modifier store —
//! there's nothing to LOOKUP in the index. We handle this by special-
//! casing height 1: walk outputs normally to seed the index, but skip
//! the input-lookup-and-remove step entirely. Mirrors the JVM's "genesis
//! has no spending inputs" path.

use anyhow::{Context, Result, anyhow, bail};
use blake2::Digest;
use blake2::digest::consts::U32;
use blake2::Blake2b;
use enr_store::{ModifierStore, RedbModifierStore};
use ergo_lib::chain::transaction::Transaction;
use ergo_lib::ergo_chain_types::Header;
use ergotree_ir::chain::context_extension::ContextExtension;
use ergotree_ir::serialization::constant_store::ConstantStore;
use ergotree_ir::serialization::sigma_byte_reader::SigmaByteReader;
use ergotree_ir::serialization::SigmaSerializable;
use sigma_ser::vlq_encode::ReadSigmaVlqExt;
use sigma_ser::ScorexSerializable;
use std::io::Cursor;

use crate::protocol::{
    BlockBundle, BlockParameters, ContextExtensionEntry, InputBundle, TxBundle,
};
use crate::utxo_index::UtxoIndex;

/// Modifier type IDs for the two block-section modifiers we fetch in T5.
/// Header (101) lookups go through `store.read_header_at` / `best_header_at`,
/// which take height rather than (type_id, modifier_id), so we don't need
/// the constant here. Match `ergo-node-rust/chain/src/section.rs:12-15`.
const BLOCK_TRANSACTIONS_TYPE_ID: u8 = 102;
const EXTENSION_TYPE_ID: u8 = 108;

/// JVM-encoded parameter ID for `MaxBlockCost`. Defined in
/// `external/sigma-rust/ergo-lib/src/chain/parameters.rs:21`.
const PARAM_ID_MAX_BLOCK_COST: i8 = 4;

/// JVM-encoded parameter ID for `SoftForkDisablingRules` (deferred — the
/// value is a variable-length encoding, and ergo-node-rust skips it when
/// reading the parameter map). Defined in
/// `external/sigma-rust/ergo-lib/src/chain/parameters.rs` next to the
/// `Parameter` enum (intentionally not represented there).
const PARAM_ID_SOFT_FORK_DISABLING_RULES: i8 = 124;

/// Version sentinel separating "block_version embedded in the leading
/// VLQ" from "leading VLQ IS the tx_count, block_version = 1". Mirrors
/// `ergo-node-rust/.worktrees/snapshot-sync/validation/src/sections.rs:75`
/// (`BLOCK_VERSION_SENTINEL = 10_000_000`).
const BLOCK_VERSION_SENTINEL: u32 = 10_000_000;

/// Ergo's genesis block height. Ergo's chain starts at h=1 — there is no
/// h=0. Confirmed via `ergo-node-rust/chain/src/chain.rs:85` (the chain
/// builder's bottom anchor) and tested in T3 against the user's live
/// store (`best_header_at(0)` returns `None`; `best_header_at(1)`
/// returns the genesis id).
const GENESIS_HEIGHT: u32 = 1;

/// 32-byte Blake2b-256 hash of three concatenated inputs (a section
/// prefix byte plus two 32-byte digests). Mirrors `prefixedHash` in
/// `ergo-node-rust/chain/src/section.rs:60`:
///
/// ```ignore
/// let mut buf = Vec::with_capacity(65);
/// buf.push(prefix);
/// buf.extend_from_slice(data1);
/// buf.extend_from_slice(data2);
/// blake2b256_hash(&buf).0
/// ```
///
/// The blake2 crate's `Blake2b<U32>` is the same parameterization
/// `sigma_util::hash::blake2b256_hash` uses (256-bit / 32-byte output).
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

/// Single-block ingestion step. Reads the header at `height`, fetches
/// the corresponding BlockTransactions and Extension sections, walks
/// transactions through the UTXO index, and returns the assembled
/// `BlockBundle`.
///
/// Side effects on the sidecar `index`:
/// - Every transaction's outputs are INSERTed into the boxes table.
/// - Every spending input's referenced box is REMOVEd from the boxes
///   table — exception: at `GENESIS_HEIGHT`, input lookups are skipped
///   entirely (Risk-hotspot #9 in the harness design spec).
/// - Data-input lookups do NOT remove the entry.
///
/// Errors:
/// - `missing-block` is NOT raised here — `main.rs` does that check
///   before invoking `ingest_block`. If `best_header_at(height)`
///   returns `None`, the caller emits the error and never reaches this
///   function.
/// - `missing-utxo` (a spending input references a box not in the
///   index) bubbles up as an anyhow context — main.rs maps that to the
///   wire-level error code.
pub fn ingest_block(
    height: u32,
    store: &RedbModifierStore,
    index: &UtxoIndex,
) -> Result<BlockBundle> {
    // Header: parse the bytes so we can pull the two section roots out
    // (transaction_root, extension_root). `read_header_at` returns
    // Some at this point because main.rs's GET_BLOCK already verified
    // `best_header_at(height)` is Some for the *target* height, and
    // intermediate heights from indexed+1..target are in BEST_CHAIN
    // (otherwise the walk wouldn't be expected to succeed). We still
    // bubble Err for "intermediate height missing in PRIMARY" rather
    // than panicking — a real store-race surfaces as a structured
    // error to the harness.
    let header_bytes = store
        .read_header_at(height)
        .with_context(|| format!("read_header_at({height})"))?
        .ok_or_else(|| {
            anyhow!(
                "read_header_at({height}) returned None mid-walk; \
                 BEST_CHAIN/PRIMARY out of sync"
            )
        })?;

    // sigma-rust's Header includes the `id` field — it's reconstructed
    // by the parser if the wire encoding contains it. But the wire
    // header bytes the node stores do NOT include the id (the id is
    // derived by Blake2b256 over the header bytes themselves). We
    // sidestep this by deriving the canonical id the same way main.rs
    // does for fingerprinting: read it from BEST_CHAIN. This is also
    // strictly faster than re-hashing.
    let header_id = store
        .best_header_at(height)
        .with_context(|| format!("best_header_at({height}) during walker re-fetch"))?
        .ok_or_else(|| {
            anyhow!(
                "best_header_at({height}) returned None during walk; \
                 BEST_CHAIN race with another writer"
            )
        })?;

    // Header is a Scorex-serializable (not Sigma-serializable). The parser
    // re-derives `header.id` internally (via Blake2b256 over the parsed
    // body), so we can cross-check it against the canonical `header_id`
    // we read from BEST_CHAIN below — but we don't strictly need to:
    // the id is consensus-derived from the same bytes.
    let header = Header::scorex_parse_bytes(&header_bytes).with_context(|| {
        format!(
            "Header::scorex_parse_bytes at height {height} (header_bytes.len() = {})",
            header_bytes.len()
        )
    })?;

    let parent_id = header.parent_id.0.0;
    let tx_root = header.transaction_root.0;
    let ext_root = header.extension_root.0;

    // ----- BlockTransactions (type 102) -----
    // Modifier id = blake2b256(102 || header_id || transaction_root).
    let block_txs_id = prefixed_hash(BLOCK_TRANSACTIONS_TYPE_ID, &header_id, &tx_root);
    let block_txs_bytes = store
        .get(BLOCK_TRANSACTIONS_TYPE_ID, &block_txs_id)
        .with_context(|| {
            format!(
                "store.get(102, {}) for block transactions at height {height}",
                hex_short(&block_txs_id)
            )
        })?
        .ok_or_else(|| {
            anyhow!(
                "BlockTransactions modifier missing for height {height} \
                 (derived id = {})",
                hex_short(&block_txs_id)
            )
        })?;

    let transactions = parse_and_walk_transactions(
        &block_txs_bytes,
        &header_id,
        height,
        index,
    )
    .with_context(|| format!("parsing BlockTransactions at height {height}"))?;

    // ----- Extension (type 108) -----
    // Modifier id = blake2b256(108 || header_id || extension_root).
    // The Extension section is small (a list of 2-byte key / ≤255-byte
    // value pairs), so failures here are not load-bearing for the
    // walker — if parameter extraction errors out, we degrade to
    // `parameters = None` and proceed. The harness can still complete
    // its passes without the per-block cost ceiling (T10 falls back to
    // the network default).
    //
    // We do still require the modifier itself to be present in the
    // store — a missing Extension is a more serious store-completeness
    // failure than a malformed payload, and bubbling that as an error
    // is the right call.
    let ext_id = prefixed_hash(EXTENSION_TYPE_ID, &header_id, &ext_root);
    let ext_bytes = store
        .get(EXTENSION_TYPE_ID, &ext_id)
        .with_context(|| {
            format!(
                "store.get(108, {}) for extension at height {height}",
                hex_short(&ext_id)
            )
        })?
        .ok_or_else(|| {
            anyhow!(
                "Extension modifier missing for height {height} \
                 (derived id = {})",
                hex_short(&ext_id)
            )
        })?;

    let parameters = match parse_extension_parameters(&ext_bytes, &header_id) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "block_walker: extension parse failed at height {height} \
                 ({e:#}); emitting parameters = None"
            );
            None
        }
    };

    Ok(BlockBundle {
        height,
        block_id: header_id,
        parent_id,
        header_bytes,
        transactions,
        parameters,
    })
}

/// Parse the BlockTransactions payload and walk every tx through the
/// UTXO index. Returns the populated `Vec<TxBundle>`.
///
/// Wire format (see file-level docs): leading 32-byte header_id, then a
/// VLQ that either IS the tx_count (block_version 1) or is `block_version
/// + BLOCK_VERSION_SENTINEL` followed by a separate tx_count VLQ.
fn parse_and_walk_transactions(
    data: &[u8],
    expected_header_id: &[u8; 32],
    height: u32,
    index: &UtxoIndex,
) -> Result<Vec<TxBundle>> {
    if data.len() < 33 {
        bail!(
            "BlockTransactions at height {height} too short: {} bytes (need at least 33)",
            data.len()
        );
    }
    let embedded_header_id: [u8; 32] = data[..32].try_into().expect("len-checked above");
    if embedded_header_id != *expected_header_id {
        bail!(
            "BlockTransactions header_id mismatch at height {height}: \
             expected {}, got {}",
            hex_short(expected_header_id),
            hex_short(&embedded_header_id)
        );
    }

    let mut cursor = Cursor::new(&data[32..]);
    let ver_or_count = cursor.get_u32().with_context(|| {
        format!("reading ver_or_count VLQ for BlockTransactions at height {height}")
    })?;

    let tx_count: usize = if ver_or_count > BLOCK_VERSION_SENTINEL {
        let _block_version = ver_or_count - BLOCK_VERSION_SENTINEL; // unused but parsed for cursor advance
        let count = cursor.get_u32().with_context(|| {
            format!("reading tx_count VLQ for BlockTransactions at height {height}")
        })?;
        count as usize
    } else {
        ver_or_count as usize
    };

    // Tx parsing uses sigma-rust's SigmaByteReader so each
    // `Transaction::sigma_parse` advances the cursor through the input.
    let pos = 32 + cursor.position() as usize;
    let tx_cursor = Cursor::new(&data[pos..]);
    let mut reader = SigmaByteReader::new(tx_cursor, ConstantStore::empty());

    let mut bundles = Vec::with_capacity(tx_count);
    for tx_idx in 0..tx_count {
        let tx = Transaction::sigma_parse(&mut reader)
            .with_context(|| format!("Transaction::sigma_parse #{tx_idx} at height {height}"))?;
        let bundle = walk_transaction(&tx, height, tx_idx, index).with_context(|| {
            format!("walking tx #{tx_idx} (id = {}) at height {height}", tx.id())
        })?;
        bundles.push(bundle);
    }

    Ok(bundles)
}

/// Walk a single transaction's outputs (insert), inputs (lookup + remove,
/// skipping at genesis), and data inputs (lookup) through the sidecar
/// index. Returns the assembled `TxBundle`.
fn walk_transaction(
    tx: &Transaction,
    height: u32,
    tx_idx: usize,
    index: &UtxoIndex,
) -> Result<TxBundle> {
    // TxId(pub Digest32) and Digest32 = Digest<32>(pub [u8; 32]) — the
    // outer field is public, so `tx.id().0.0` is the [u8; 32]. We do not
    // own the value, but [u8; 32] is Copy.
    let tx_id_arr: [u8; 32] = tx.id().0.0;
    let signing_message = tx
        .bytes_to_sign()
        .with_context(|| format!("Transaction::bytes_to_sign for tx #{tx_idx} at height {height}"))?;

    // Outputs first: at genesis these are the inaugural index entries,
    // and even off-genesis, sigma-rust permits a tx output to be
    // referenced as a same-tx data-input. Doing outputs first sidesteps
    // a potential ordering bug.
    let mut outputs = Vec::with_capacity(tx.outputs.len());
    for (out_idx, out) in tx.outputs.iter().enumerate() {
        // BoxId(Digest32) with a *private* inner field; use AsRef<[u8]>.
        let box_id_arr: [u8; 32] = out.box_id().as_ref().try_into()
            .expect("BoxId is always 32 bytes");
        let box_bytes = out
            .sigma_serialize_bytes()
            .with_context(|| {
                format!(
                    "ErgoBox::sigma_serialize_bytes for tx #{tx_idx} output #{out_idx} \
                     at height {height}"
                )
            })?;
        index
            .insert(&box_id_arr, &box_bytes)
            .with_context(|| {
                format!(
                    "UtxoIndex insert for tx #{tx_idx} output #{out_idx} \
                     (box_id {}) at height {height}",
                    hex_short(&box_id_arr)
                )
            })?;
        outputs.push(box_bytes);
    }

    // Inputs: at genesis there's nothing to remove (synthetic emission
    // box lives outside the index). Off-genesis, each input MUST resolve
    // to an index entry — a miss is a `missing-utxo` consensus violation.
    let mut input_bundles = Vec::with_capacity(tx.inputs.len());
    for (in_idx, input) in tx.inputs.iter().enumerate() {
        let box_id_arr: [u8; 32] = input.box_id.as_ref().try_into()
            .expect("BoxId is always 32 bytes");

        let spent_box_bytes = if height == GENESIS_HEIGHT {
            // Genesis: skip lookup-and-remove. Emit an empty spent-box
            // payload so the harness sees a stable shape; downstream
            // passes (T9 round-trip / T10 verify) should be skipping
            // genesis inputs anyway (no real spent box exists).
            Vec::new()
        } else {
            index
                .remove(&box_id_arr)
                .with_context(|| {
                    format!(
                        "UtxoIndex remove for tx #{tx_idx} input #{in_idx} \
                         (box_id {}) at height {height}",
                        hex_short(&box_id_arr)
                    )
                })?
                .ok_or_else(|| {
                    anyhow!(
                        "missing-utxo: tx #{tx_idx} input #{in_idx} at height {height} \
                         references box {} which is not in the UTXO index",
                        hex_short(&box_id_arr)
                    )
                })?
        };

        let signature_bytes = input.spending_proof.proof.clone().to_bytes();
        let context_extension =
            serialize_context_extension(&input.spending_proof.extension).with_context(|| {
                format!(
                    "serializing context extension for tx #{tx_idx} input #{in_idx} \
                     at height {height}"
                )
            })?;

        input_bundles.push(InputBundle {
            box_id: box_id_arr,
            spent_box_bytes,
            signature_bytes,
            context_extension,
        });
    }

    // Data inputs: lookup only, no remove. At genesis we still attempt
    // the lookup but expect zero data-inputs (the canonical genesis tx
    // has none); a non-empty data-input list at h=1 with a missing
    // index entry is a chain anomaly worth surfacing.
    let data_inputs_iter = tx.data_inputs.as_ref().map(|di| di.as_vec().as_slice()).unwrap_or(&[]);
    let mut data_input_boxes = Vec::with_capacity(data_inputs_iter.len());
    for (di_idx, data_input) in data_inputs_iter.iter().enumerate() {
        let box_id_arr: [u8; 32] = data_input.box_id.as_ref().try_into()
            .expect("BoxId is always 32 bytes");
        let box_bytes = index
            .get(&box_id_arr)
            .with_context(|| {
                format!(
                    "UtxoIndex get for tx #{tx_idx} data_input #{di_idx} \
                     (box_id {}) at height {height}",
                    hex_short(&box_id_arr)
                )
            })?
            .ok_or_else(|| {
                anyhow!(
                    "missing-data-utxo: tx #{tx_idx} data_input #{di_idx} at height {height} \
                     references box {} which is not in the UTXO index",
                    hex_short(&box_id_arr)
                )
            })?;
        data_input_boxes.push(box_bytes);
    }

    Ok(TxBundle {
        tx_id: tx_id_arr,
        signing_message,
        inputs: input_bundles,
        outputs,
        data_input_boxes,
    })
}

/// Serialize each value of a `ContextExtension` via `Constant::sigma_serialize`
/// and pair it with its `var_id`. The `IndexMap<u8, Constant>` preserves
/// insertion order so the wire-emitted list is stable across runs.
fn serialize_context_extension(ext: &ContextExtension) -> Result<Vec<ContextExtensionEntry>> {
    let mut out = Vec::with_capacity(ext.values.len());
    for (&var_id, constant) in ext.values.iter() {
        let value_bytes = constant.sigma_serialize_bytes().with_context(|| {
            format!("Constant::sigma_serialize_bytes for context extension var_id {var_id}")
        })?;
        out.push(ContextExtensionEntry {
            var_id,
            value_bytes,
        });
    }
    Ok(out)
}

/// Parse the Extension section (type 108) raw bytes and extract the
/// blockchain-parameters snapshot.
///
/// Returns:
/// - `Ok(Some(BlockParameters))` when `max_block_cost` is present in
///   the extension's parameter table.
/// - `Ok(None)` when the extension parses cleanly but doesn't carry
///   `max_block_cost` (early version-1 blocks).
/// - `Err(_)` when the extension bytes are malformed (truncated,
///   header_id mismatch, invalid field length).
///
/// The caller in `ingest_block` downgrades `Err` to `parameters = None`
/// with a stderr warning, on the principle that a parameter-extraction
/// failure shouldn't kill the entire walker — the rest of the bundle
/// (transactions, header) is still useful to the harness.
fn parse_extension_parameters(
    data: &[u8],
    expected_header_id: &[u8; 32],
) -> Result<Option<BlockParameters>> {
    if data.len() < 33 {
        bail!(
            "Extension section too short: {} bytes (need at least 33)",
            data.len()
        );
    }
    let embedded_header_id: [u8; 32] = data[..32].try_into().expect("len-checked above");
    if embedded_header_id != *expected_header_id {
        bail!(
            "Extension header_id mismatch: expected {}, got {}",
            hex_short(expected_header_id),
            hex_short(&embedded_header_id)
        );
    }

    let mut cursor = Cursor::new(&data[32..]);
    let field_count = cursor
        .get_u32()
        .context("reading Extension field_count VLQ")? as usize;

    let mut pos = 32 + cursor.position() as usize;
    let mut max_block_cost: Option<i32> = None;

    for i in 0..field_count {
        if pos + 3 > data.len() {
            bail!(
                "Extension field {i}: truncated (need 3 bytes for key+len, have {})",
                data.len() - pos
            );
        }
        let key: [u8; 2] = data[pos..pos + 2].try_into().expect("len-checked above");
        let value_len = data[pos + 2] as usize;
        pos += 3;
        if pos + value_len > data.len() {
            bail!(
                "Extension field {i}: value_len {} exceeds remaining {} bytes",
                value_len,
                data.len() - pos
            );
        }
        let value = &data[pos..pos + value_len];
        pos += value_len;

        // Parameter table prefix is `0x00`. Anything else is a non-parameter
        // extension field (e.g. interlinks, NiPoPoW data) and we skip it.
        if key[0] != 0x00 {
            continue;
        }
        let param_id = key[1] as i8;
        if param_id == PARAM_ID_SOFT_FORK_DISABLING_RULES {
            // Variable-length payload; ergo-node-rust skips it for the
            // same reason (no sigma-rust serializer exposed).
            continue;
        }
        if param_id != PARAM_ID_MAX_BLOCK_COST {
            // Other parameters exist (storage fee, input/output cost,
            // etc.) but T5 only emits max_block_cost at the BlockBundle
            // level. Skip the rest; future passes can extend the
            // `BlockParameters` struct to surface them additively.
            continue;
        }
        if value.len() != 4 {
            bail!(
                "Extension field {i}: param id {param_id} (max_block_cost) \
                 has wrong value length: expected 4, got {}",
                value.len()
            );
        }
        let mut buf = [0u8; 4];
        buf.copy_from_slice(value);
        max_block_cost = Some(i32::from_be_bytes(buf));
    }

    Ok(max_block_cost.map(|max_block_cost| BlockParameters { max_block_cost }))
}

/// Render the first 4 + last 4 bytes of a 32-byte digest as
/// `"aabbccdd…eeff0011"` for terse error messages. Full ID isn't useful
/// in a single-line error (and base16 of 32 bytes is 64 characters).
fn hex_short(id: &[u8; 32]) -> String {
    let lo = &id[..4];
    let hi = &id[28..];
    format!(
        "{:02x}{:02x}{:02x}{:02x}...{:02x}{:02x}{:02x}{:02x}",
        lo[0], lo[1], lo[2], lo[3], hi[0], hi[1], hi[2], hi[3]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `prefixed_hash` must match `ergo-node-rust/chain/src/section.rs:60-66`
    /// byte-for-byte. We can't easily call into that without the dep,
    /// so we cross-check against the official Blake2b-256 of a known
    /// input — `prefix=0x66, data1=0x11×32, data2=0x22×32` — computed
    /// independently via `ergo-chain-types::blake2b256_hash`.
    ///
    /// This test exercises:
    /// - The exact 65-byte concatenation order.
    /// - 256-bit (`U32`) output width (the blake2 crate has multiple
    ///   parameterizations; using `Blake2b<U64>` would silently truncate
    ///   the first 32 bytes — different bytes from sigma-util's hash).
    #[test]
    fn prefixed_hash_matches_blake2b256() {
        // Compute the reference value via ergo-chain-types (the same
        // library section.rs uses).
        let mut buf = Vec::with_capacity(65);
        buf.push(0x66);
        buf.extend_from_slice(&[0x11u8; 32]);
        buf.extend_from_slice(&[0x22u8; 32]);
        let reference = ergo_lib::ergo_chain_types::blake2b256_hash(&buf).0;

        let ours = prefixed_hash(0x66, &[0x11u8; 32], &[0x22u8; 32]);
        assert_eq!(ours, reference, "prefixed_hash must equal Blake2b256(prefix || d1 || d2)");
    }

    /// Section ID for the canonical Ergo BlockTransactions modifier must
    /// match what `chain/src/section.rs:section_ids` would produce. We
    /// hand-derive against ergo-chain-types' blake2b256_hash to confirm
    /// the prefix byte (102) and concatenation order.
    #[test]
    fn block_tx_modifier_id_uses_prefix_102() {
        let header_id = [0xABu8; 32];
        let tx_root = [0xCDu8; 32];

        let mut buf = Vec::with_capacity(65);
        buf.push(102);
        buf.extend_from_slice(&header_id);
        buf.extend_from_slice(&tx_root);
        let reference = ergo_lib::ergo_chain_types::blake2b256_hash(&buf).0;

        let ours = prefixed_hash(BLOCK_TRANSACTIONS_TYPE_ID, &header_id, &tx_root);
        assert_eq!(ours, reference);
    }

    /// Same shape, prefix 108. Both block-section IDs share the wire
    /// format; this test pins the constant to the right value.
    #[test]
    fn extension_modifier_id_uses_prefix_108() {
        let header_id = [0xEFu8; 32];
        let ext_root = [0x12u8; 32];

        let mut buf = Vec::with_capacity(65);
        buf.push(108);
        buf.extend_from_slice(&header_id);
        buf.extend_from_slice(&ext_root);
        let reference = ergo_lib::ergo_chain_types::blake2b256_hash(&buf).0;

        let ours = prefixed_hash(EXTENSION_TYPE_ID, &header_id, &ext_root);
        assert_eq!(ours, reference);
    }

    /// Helper to construct a serialised Extension section with one
    /// parameter field. Used by the parameter-extraction tests.
    fn build_extension(header_id: [u8; 32], fields: &[(u8, u8, Vec<u8>)]) -> Vec<u8> {
        use sigma_ser::vlq_encode::WriteSigmaVlqExt;

        let mut data = Vec::new();
        data.extend_from_slice(&header_id);
        // field_count VLQ
        WriteSigmaVlqExt::put_u32(&mut data, fields.len() as u32).unwrap();
        for (k0, k1, v) in fields {
            data.push(*k0);
            data.push(*k1);
            data.push(v.len() as u8);
            data.extend_from_slice(v);
        }
        data
    }

    #[test]
    fn parse_extension_parameters_extracts_max_block_cost() {
        let header_id = [0x33u8; 32];
        // max_block_cost = 1_500_000 (BE)
        let value = 1_500_000i32.to_be_bytes().to_vec();
        // key = [0x00, 0x04] (param-table prefix 0x00, param id 4 = MaxBlockCost)
        let data = build_extension(header_id, &[(0x00, 0x04, value)]);

        let params = parse_extension_parameters(&data, &header_id).expect("parse");
        assert_eq!(
            params,
            Some(BlockParameters {
                max_block_cost: 1_500_000
            })
        );
    }

    #[test]
    fn parse_extension_parameters_returns_none_when_max_block_cost_absent() {
        let header_id = [0x44u8; 32];
        // Only non-parameter fields: key prefix 0x01 (interlink chain).
        let val = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let data = build_extension(header_id, &[(0x01, 0x00, val)]);

        let params = parse_extension_parameters(&data, &header_id).expect("parse");
        assert_eq!(params, None);
    }

    #[test]
    fn parse_extension_parameters_skips_soft_fork_disabling_rules() {
        let header_id = [0x55u8; 32];
        // Field 1: id 124 (skipped). Field 2: id 4 (extracted).
        let id124_val = vec![0xFFu8; 8]; // variable-length payload
        let max_cost_val = 999_999i32.to_be_bytes().to_vec();
        let data = build_extension(
            header_id,
            &[(0x00, 124u8, id124_val), (0x00, 0x04, max_cost_val)],
        );

        let params = parse_extension_parameters(&data, &header_id).expect("parse");
        assert_eq!(
            params,
            Some(BlockParameters {
                max_block_cost: 999_999
            })
        );
    }

    #[test]
    fn parse_extension_parameters_rejects_header_id_mismatch() {
        let header_id = [0x66u8; 32];
        let mut data = build_extension(header_id, &[]);
        // Flip a byte in the embedded id and re-parse with the original.
        data[0] ^= 0x01;
        let err = parse_extension_parameters(&data, &header_id).unwrap_err();
        assert!(
            err.to_string().contains("header_id mismatch"),
            "expected header_id mismatch error, got: {err:#}"
        );
    }

    #[test]
    fn parse_extension_parameters_rejects_too_short() {
        let data = vec![0u8; 20]; // < 33
        let err = parse_extension_parameters(&data, &[0u8; 32]).unwrap_err();
        assert!(
            err.to_string().contains("too short"),
            "expected too-short error, got: {err:#}"
        );
    }

    #[test]
    fn parse_extension_parameters_rejects_wrong_value_length_for_max_block_cost() {
        let header_id = [0x77u8; 32];
        // Param id 4 with a 3-byte value instead of 4.
        let data = build_extension(header_id, &[(0x00, 0x04, vec![0x01, 0x02, 0x03])]);
        let err = parse_extension_parameters(&data, &header_id).unwrap_err();
        assert!(
            err.to_string().contains("wrong value length"),
            "expected wrong-value-length error, got: {err:#}"
        );
    }

    #[test]
    fn hex_short_renders_expected_shape() {
        let id = [
            0xDE, 0xAD, 0xBE, 0xEF, // 4 head
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 24 middle
            0xCA, 0xFE, 0xBA, 0xBE, // 4 tail
        ];
        assert_eq!(hex_short(&id), "deadbeef...cafebabe");
    }
}
