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

/// Typed error returned by `ingest_block`. Each variant corresponds to a
/// distinct wire-level error code emitted by `main.rs::handle_get_block`
/// — `code()` returns the canonical short identifier the harness
/// dispatches on, and `message()` carries the human-readable detail.
///
/// Replaces an earlier substring-match-on-anyhow-chain dispatch (whose
/// failure mode was that `"missing-data-utxo"` contains `"missing-utxo"`,
/// so data-input misses were misclassified as UTXO misses). The typed
/// enum is matched by variant; no string parsing.
#[derive(Debug)]
pub enum WalkerError {
    /// A spending input referenced a box not in the UTXO index.
    /// `box_id` is the canonical 32-byte id of the missing entry;
    /// `height` is the block at which the miss occurred. Off-genesis
    /// inputs unconditionally LOOKUP+REMOVE, so a miss is either an
    /// index-stale bug or a chain inconsistency.
    MissingUtxo { box_id: [u8; 32], height: u32 },
    /// A data input referenced a box not in the UTXO index. Distinct
    /// from `MissingUtxo` because data inputs are LOOKUP-only (no
    /// removal); a miss has the same root cause classes but the wire
    /// code is separate so the harness can apply different retry/repair
    /// policies. Note: variant name discriminates cleanly; this is
    /// where the prior substring-match bug lived.
    MissingDataUtxo { box_id: [u8; 32], height: u32 },
    /// `read_header_at(height)` returned `Some` from the BEST_CHAIN
    /// index but `best_header_at(height)` returned `None` mid-walk,
    /// or vice-versa — a smell of concurrent mutation by another
    /// writer between calls. Surface this distinctly from
    /// `MissingBlock` (target past tip) and from a generic store
    /// error.
    StoreRace { height: u32, detail: String },
    /// The BlockTransactions or Extension modifier was absent from the
    /// store at a height where BEST_CHAIN claims a header exists.
    /// Reported in addition to the generic case so the harness can
    /// distinguish "store missing a block we expected to be there"
    /// from "walker can't parse what's there." Carries the modifier
    /// type id (102 or 108) and the derived modifier id for diagnosis.
    MissingSection {
        height: u32,
        type_id: u8,
        modifier_id: [u8; 32],
    },
    /// Any other failure in the per-block walk (wire-format parse
    /// failure, header_id mismatch in an embedded section, sigma-rust
    /// `Transaction::sigma_parse` error, hash-derivation mismatch).
    /// Carries the anyhow chain so the harness's stderr capture sees
    /// the full context.
    Other(anyhow::Error),
}

impl WalkerError {
    /// Wire-level short identifier dispatched on by the harness. Must
    /// remain stable across releases for downstream catalogues.
    pub fn code(&self) -> &'static str {
        match self {
            WalkerError::MissingUtxo { .. } => "missing-utxo",
            WalkerError::MissingDataUtxo { .. } => "missing-data-utxo",
            WalkerError::StoreRace { .. } => "store-race",
            WalkerError::MissingSection { .. } => "missing-section",
            WalkerError::Other(_) => "walker-error",
        }
    }

    /// Human-readable message rendered into the wire error payload.
    /// For `Other`, this is the anyhow-formatted chain (`{e:#}`).
    pub fn message(&self) -> String {
        match self {
            WalkerError::MissingUtxo { box_id, height } => format!(
                "tx input at height {height} references box {} which is \
                 not in the UTXO index",
                hex_full(box_id)
            ),
            WalkerError::MissingDataUtxo { box_id, height } => format!(
                "tx data-input at height {height} references box {} which \
                 is not in the UTXO index",
                hex_full(box_id)
            ),
            WalkerError::StoreRace { height, detail } => format!(
                "store-race at height {height}: {detail}"
            ),
            WalkerError::MissingSection {
                height,
                type_id,
                modifier_id,
            } => format!(
                "section type {type_id} modifier {} missing at height {height}",
                hex_short(modifier_id)
            ),
            WalkerError::Other(e) => format!("{e:#}"),
        }
    }
}

impl From<anyhow::Error> for WalkerError {
    fn from(e: anyhow::Error) -> Self {
        WalkerError::Other(e)
    }
}

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
/// Errors are returned as the typed `WalkerError` enum (each variant
/// maps to a wire-level error code via `WalkerError::code()`):
/// - `MissingUtxo` / `MissingDataUtxo`: spending or data input
///   references a box not in the index.
/// - `MissingSection`: BlockTransactions or Extension modifier
///   missing in the store at this height.
/// - `StoreRace`: `read_header_at` returned `Some` but
///   `best_header_at` returned `None` (or vice-versa) mid-walk.
/// - `Other`: any other failure (parse error, embedded-id mismatch,
///   etc.) — carries the anyhow chain.
///
/// `MissingBlock` is NOT emitted here — `main.rs` checks that BEFORE
/// invoking `ingest_block`. If `best_header_at(height)` returns
/// `None`, the caller emits the wire error and never reaches this
/// function.
pub fn ingest_block(
    height: u32,
    store: &RedbModifierStore,
    index: &UtxoIndex,
) -> Result<BlockBundle, WalkerError> {
    // Header: parse the bytes so we can pull the two section roots out
    // (transaction_root, extension_root). `read_header_at` returns
    // Some at this point because main.rs's GET_BLOCK already verified
    // `best_header_at(height)` is Some for the *target* height, and
    // intermediate heights from indexed+1..target are in BEST_CHAIN
    // (otherwise the walk wouldn't be expected to succeed). We
    // surface a store-race for "intermediate height missing in
    // PRIMARY despite BEST_CHAIN claiming a header at h" — the
    // walker isn't the actor that mutated the store, so this is a
    // concurrent-writer race rather than a walker bug.
    let header_bytes = store
        .read_header_at(height)
        .with_context(|| format!("read_header_at({height})"))?
        .ok_or_else(|| WalkerError::StoreRace {
            height,
            detail: "read_header_at returned None mid-walk; BEST_CHAIN/PRIMARY out of sync"
                .to_string(),
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
        .ok_or_else(|| WalkerError::StoreRace {
            height,
            detail: "best_header_at returned None during walk; BEST_CHAIN race with another \
                     writer"
                .to_string(),
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
        .ok_or_else(|| WalkerError::MissingSection {
            height,
            type_id: BLOCK_TRANSACTIONS_TYPE_ID,
            modifier_id: block_txs_id,
        })?;

    let transactions = parse_and_walk_transactions(
        &block_txs_bytes,
        &header_id,
        height,
        index,
        &header_bytes,
    )
    .map_err(|e| match e {
        // Preserve typed missing-utxo / missing-data-utxo variants;
        // only wrap the generic-parse-failure branch with the
        // "parsing BlockTransactions at height H" context. Doing the
        // wrap unconditionally would erase the typed variant inside
        // a WalkerError::Other and re-introduce the substring-match
        // problem.
        WalkerError::Other(err) => WalkerError::Other(
            err.context(format!("parsing BlockTransactions at height {height}")),
        ),
        other => other,
    })?;

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
        .ok_or_else(|| WalkerError::MissingSection {
            height,
            type_id: EXTENSION_TYPE_ID,
            modifier_id: ext_id,
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
///
/// Returns `WalkerError::MissingUtxo` / `MissingDataUtxo` for the typed
/// per-input miss paths, and `WalkerError::Other(_)` for parse/format
/// failures.
fn parse_and_walk_transactions(
    data: &[u8],
    expected_header_id: &[u8; 32],
    height: u32,
    index: &UtxoIndex,
    header_bytes: &[u8],
) -> Result<Vec<TxBundle>, WalkerError> {
    if data.len() < 33 {
        return Err(WalkerError::Other(anyhow!(
            "BlockTransactions at height {height} too short: {} bytes (need at least 33)",
            data.len()
        )));
    }
    let embedded_header_id: [u8; 32] = data[..32].try_into().expect("len-checked above");
    if embedded_header_id != *expected_header_id {
        return Err(WalkerError::Other(anyhow!(
            "BlockTransactions header_id mismatch at height {height}: \
             expected {}, got {}",
            hex_short(expected_header_id),
            hex_short(&embedded_header_id)
        )));
    }

    let mut cursor = Cursor::new(&data[32..]);
    let ver_or_count = cursor.get_u32().with_context(|| {
        format!("reading ver_or_count VLQ for BlockTransactions at height {height}")
    })?;

    let tx_count: usize = if ver_or_count > BLOCK_VERSION_SENTINEL {
        // Discard intermediate value; cursor was already advanced by
        // the prior `get_u32()` call. The arithmetic here is purely
        // documentation — the block_version is the sentinel-subtracted
        // remainder — and isn't fed back into parsing because the
        // remainder of the BlockTransactions wire format is
        // version-stable.
        let _block_version = ver_or_count - BLOCK_VERSION_SENTINEL;
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
        let tx_id_for_ctx = tx.id();
        let bundle = walk_transaction(&tx, height, tx_idx, index, header_bytes).map_err(|e| match e {
            // Same preservation pattern as in `ingest_block`: only
            // wrap the generic branch with tx-index context. The
            // typed MissingUtxo / MissingDataUtxo variants already
            // carry box_id + height so additional anyhow context
            // would be redundant.
            WalkerError::Other(err) => WalkerError::Other(err.context(format!(
                "walking tx #{tx_idx} (id = {tx_id_for_ctx}) at height {height}"
            ))),
            other => other,
        })?;
        bundles.push(bundle);
    }

    Ok(bundles)
}

/// Walk a single transaction's outputs (insert), inputs (lookup + remove,
/// skipping at genesis), and data inputs (lookup) through the sidecar
/// index. Returns the assembled `TxBundle`.
///
/// Returns `WalkerError::MissingUtxo` (input box absent) or
/// `WalkerError::MissingDataUtxo` (data-input box absent) for the
/// typed per-input miss paths, and `WalkerError::Other(_)` for any
/// other failure (serialization, registry lookup, etc.).
fn walk_transaction(
    tx: &Transaction,
    height: u32,
    tx_idx: usize,
    index: &UtxoIndex,
    header_bytes: &[u8],
) -> Result<TxBundle, WalkerError> {
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

    // Data inputs MUST be looked up BEFORE inputs are removed. Per Ergo
    // consensus, a tx's data-inputs and inputs are evaluated against the
    // same pre-tx UTXO snapshot — both must exist when the spending
    // scripts run. Mainnet has at least one canonical tx (h=204570 tx#1)
    // where the same box id appears in BOTH `tx.inputs` AND
    // `tx.data_inputs`; processing inputs first would `remove` the box
    // before the data-input `get`, surfacing as a spurious
    // `missing-data-utxo` halt. Discovered during 2j-b T7 first loop
    // run; see commit prefix `fix(2j-b/shim-tx-order):`.
    //
    // The current implementation is lookup-only for data-inputs (no
    // remove), so the order between data-inputs and outputs (above) is
    // irrelevant — only the data-inputs-before-inputs ordering matters
    // for consensus correctness.
    //
    // At genesis we still attempt the lookup but expect zero data-inputs
    // (the canonical genesis tx has none); a non-empty data-input list
    // at h=1 with a missing index entry is a chain anomaly worth
    // surfacing.
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
            .ok_or(WalkerError::MissingDataUtxo {
                box_id: box_id_arr,
                height,
            })?;
        data_input_boxes.push(box_bytes);
    }

    // Inputs: each input MUST resolve to an index entry — a miss is a
    // `missing-utxo` consensus violation. Per phase 2j-pre fix-2 the
    // sidecar is now seeded with the 3 Ergo genesis-state boxes
    // (emission, no_premine, founders) at init time, so the previous
    // GENESIS_HEIGHT input-skip special-case (fix-1 era) is obsolete:
    // at height 1, the emission spend resolves cleanly via the standard
    // walker path.
    let mut input_bundles = Vec::with_capacity(tx.inputs.len());
    for (in_idx, input) in tx.inputs.iter().enumerate() {
        let box_id_arr: [u8; 32] = input.box_id.as_ref().try_into()
            .expect("BoxId is always 32 bytes");

        let spent_box_bytes = index
            .remove(&box_id_arr)
            .with_context(|| {
                format!(
                    "UtxoIndex remove for tx #{tx_idx} input #{in_idx} \
                     (box_id {}) at height {height}",
                    hex_short(&box_id_arr)
                )
            })?
            .ok_or(WalkerError::MissingUtxo {
                box_id: box_id_arr,
                height,
            })?;

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
            // Filled in after the input loop completes, when we have all
            // parsed boxes available for TransactionContext.
            oracle_cost: 0,
            oracle_succeeded: false,
            oracle_error: None,
        });
    }

    // Phase 2j-a T5: compute sigma-rust's per-input oracle cost for the
    // entire transaction's inputs and populate the oracle_* fields on
    // each InputBundle. Done as a second pass because TransactionContext
    // construction requires all input + data-input boxes parsed into
    // ErgoBox up-front. We deliberately use Parameters::default() and an
    // empty rolling-headers window here — the shim doesn't yet maintain
    // per-block state across the walk loop. For typical mainnet inputs
    // (P2PK and similar trivial trees), default Parameters and stub
    // headers don't affect the cost charged (the trivial-prop short-circuit
    // doesn't read context). Inputs that read CONTEXT.headers or rely on
    // tight cost-limit semantics may show spurious mismatches in the
    // first T9 smoke; surfacing those is the point of the TDD loop.
    let boxes_to_spend: Vec<ergotree_ir::chain::ergo_box::ErgoBox> = input_bundles
        .iter()
        .enumerate()
        .map(|(i, ib)| {
            ergotree_ir::serialization::SigmaSerializable::sigma_parse_bytes(&ib.spent_box_bytes)
                .with_context(|| {
                    format!(
                        "ErgoBox::sigma_parse_bytes for tx #{tx_idx} input #{i} at height {height}"
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let data_boxes: Vec<ergotree_ir::chain::ergo_box::ErgoBox> = data_input_boxes
        .iter()
        .enumerate()
        .map(|(i, b)| {
            ergotree_ir::serialization::SigmaSerializable::sigma_parse_bytes(b)
                .with_context(|| {
                    format!(
                        "ErgoBox::sigma_parse_bytes for tx #{tx_idx} data_input #{i} at height {height}"
                    )
                })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let tx_ctx = match ergo_lib::wallet::tx_context::TransactionContext::new(
        tx.clone(),
        boxes_to_spend,
        data_boxes,
    ) {
        Ok(c) => Some(c),
        Err(e) => {
            // TransactionContext construction can fail if e.g. input box
            // count exceeds the bounded-vec limit. Mark all inputs as
            // oracle-failed with the construct error captured.
            let msg = format!("TransactionContext::new failed: {e}");
            for ib in input_bundles.iter_mut() {
                ib.oracle_succeeded = false;
                ib.oracle_error = Some(msg.clone());
            }
            None
        }
    };

    if let Some(tx_ctx) = tx_ctx {
        match crate::cost_oracle::build_state_context(
            header_bytes,
            &[],
            ergo_lib::chain::parameters::Parameters::default(),
        ) {
            Ok(state_ctx) => {
                for (i, ib) in input_bundles.iter_mut().enumerate() {
                    let result =
                        crate::cost_oracle::compute_oracle_cost(&tx_ctx, &state_ctx, i);
                    ib.oracle_cost = result.cost;
                    ib.oracle_succeeded = result.is_ok;
                    ib.oracle_error = result.error_msg;
                }
            }
            Err(e) => {
                let msg = format!("build_state_context failed: {e}");
                for ib in input_bundles.iter_mut() {
                    ib.oracle_succeeded = false;
                    ib.oracle_error = Some(msg.clone());
                }
            }
        }
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

/// Render all 32 bytes as a 64-char lowercase hex string. Used for
/// `MissingUtxo` / `MissingDataUtxo` error messages where a downstream
/// triage step needs the exact box_id to look up a producer.
fn hex_full(id: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for b in id {
        s.push_str(&format!("{b:02x}"));
    }
    s
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

    /// Integration test: a synthetic genesis-height block survives the
    /// full `ingest_block` walk path end-to-end.
    ///
    /// Construction recipe (revised for phase 2j-pre fix-2):
    /// 1. Construct the 3 Ergo mainnet genesis-state boxes via
    ///    `ergo_lib::chain::genesis::genesis_boxes(...)` with
    ///    `MonetarySettings::default()` + the FOUNDERS_PKS / mainnet
    ///    no-premine proof strings from `genesis_constants.rs`.
    /// 2. Build a P2PK output box (value = SAFE_USER_MIN, pubkey =
    ///    secp256k1 generator point).
    /// 3. Build a single-input `Transaction` whose input box_id is
    ///    the EMISSION box's id (the canonical id sigma-rust derives
    ///    via blake2b256(sigma_serialize_bytes)). The walker no
    ///    longer special-cases GENESIS_HEIGHT (per spec Decision 3);
    ///    the input MUST resolve to an entry in the seeded sidecar.
    /// 4. Serialize tx + header; write into temp store.
    /// 5. Open sidecar seeded with the 3 genesis boxes (matches the
    ///    production flow that main.rs now wires via T5a).
    /// 6. Call `ingest_block(GENESIS_HEIGHT, &store, &sidecar)`.
    /// 7. Assertions:
    ///    - bundle shape (height, block_id, parent_id, header_bytes).
    ///    - one transaction with one input whose `spent_box_bytes`
    ///      equals the seeded emission box's sigma_serialize_bytes
    ///      (REMOVE captured the seeded bytes).
    ///    - one output INSERTed into the sidecar.
    ///    - the emission box is no longer in the sidecar (REMOVE
    ///      happened).
    ///    - the OTHER two genesis-state boxes (no_premine, founders)
    ///      are still in the sidecar (untouched by this block).
    ///
    /// This rewrites the previous version which used
    /// `BoxId::zero()` as input + asserted `spent_box_bytes.is_empty()`.
    /// That version relied on the GENESIS_HEIGHT input-skip
    /// special-case removed in T7 of the fix-2 plan.
    #[test]
    fn ingest_block_walks_synthetic_genesis_block_end_to_end() {
        use crate::genesis_constants::{FOUNDERS_PKS, MAINNET_NO_PREMINE_PROOFS};
        use ergo_lib::chain::emission::MonetarySettings;
        use ergo_lib::chain::genesis;
        use ergo_lib::chain::transaction::input::Input;
        use ergo_lib::chain::transaction::prover_result::ProverResult;
        use ergo_lib::ergo_chain_types::{
            blake2b256_hash, ec_point, AutolykosSolution, BlockId, Digest, Digest32, EcPoint,
            Header, Votes,
        };
        use ergo_lib::ergotree_interpreter::sigma_protocol::prover::ProofBytes;
        use ergo_lib::ergotree_ir::sigma_protocol::sigma_boolean::ProveDlog;
        use ergotree_ir::chain::context_extension::ContextExtension;
        use ergotree_ir::chain::ergo_box::box_value::BoxValue;
        use ergotree_ir::chain::ergo_box::{BoxId, ErgoBoxCandidate, NonMandatoryRegisters};
        use ergotree_ir::ergo_tree::ErgoTree;
        use sigma_ser::vlq_encode::WriteSigmaVlqExt;
        use tempfile::TempDir;

        // ----- Step 0: build the 3 Ergo genesis-state boxes (mainnet) -----
        let settings = MonetarySettings::default();
        // Hex-decode founder pubkeys (verbatim copy of main.rs:hex_decode logic).
        fn hex_decode(s: &str) -> Vec<u8> {
            let mut out = Vec::with_capacity(s.len() / 2);
            for chunk in s.as_bytes().chunks(2) {
                let hi = (chunk[0] as char).to_digit(16).unwrap() as u8;
                let lo = (chunk[1] as char).to_digit(16).unwrap() as u8;
                out.push((hi << 4) | lo);
            }
            out
        }
        let founders_pks: Vec<ProveDlog> = FOUNDERS_PKS
            .iter()
            .map(|s| {
                let bytes = hex_decode(s);
                let point = EcPoint::sigma_parse_bytes(&bytes).expect("EcPoint parse");
                ProveDlog::new(point)
            })
            .collect();
        let (emission_box, no_premine_box, founders_box) = genesis::genesis_boxes(
            &settings,
            &founders_pks,
            2,
            MAINNET_NO_PREMINE_PROOFS,
        )
        .expect("genesis_boxes");

        let emission_id: [u8; 32] = emission_box.box_id().as_ref().try_into().unwrap();
        let emission_bytes = emission_box.sigma_serialize_bytes().expect("emission ser");
        let no_premine_id: [u8; 32] = no_premine_box.box_id().as_ref().try_into().unwrap();
        let no_premine_bytes = no_premine_box.sigma_serialize_bytes().expect("np ser");
        let founders_id: [u8; 32] = founders_box.box_id().as_ref().try_into().unwrap();
        let founders_bytes = founders_box.sigma_serialize_bytes().expect("founders ser");

        let genesis_seed: Vec<([u8; 32], Vec<u8>)> = vec![
            (emission_id, emission_bytes.clone()),
            (no_premine_id, no_premine_bytes.clone()),
            (founders_id, founders_bytes.clone()),
        ];

        // ----- Step 1: build the P2PK output box. -----
        // Minimal valid ergo_tree (no constant segregation header
        // byte, SigmaPropConstant of secp256k1 generator). Hex:
        //   00       = ErgoTreeHeader v0, no segregation
        //   08cd     = SigmaPropConstant of GroupElement
        //   <33B>    = secp256k1 generator compressed
        let ergo_tree_bytes = {
            let mut v = vec![0x00u8, 0x08u8, 0xcdu8];
            // Use a well-known compressed public key (sigma-rust test
            // fixture from wallet/signing.rs:533): the 33-byte
            // secp256k1-compressed encoding of a valid point. Any valid
            // 33-byte compressed secp256k1 point would do.
            v.extend_from_slice(&[
                0x03, 0x27, 0xe6, 0x57, 0x11, 0xa5, 0x93, 0x78, 0xc5, 0x93, 0x59, 0xc3, 0xe1,
                0xd0, 0xf7, 0xab, 0xe9, 0x06, 0x47, 0x9e, 0xcc, 0xb7, 0x60, 0x94, 0xe5, 0x0f,
                0xe7, 0x9d, 0x74, 0x3c, 0xcc, 0x15, 0xe6,
            ]);
            v
        };
        let ergo_tree =
            ErgoTree::sigma_parse_bytes(&ergo_tree_bytes).expect("parse minimal ergo tree");

        let output_candidate = ErgoBoxCandidate {
            value: BoxValue::SAFE_USER_MIN,
            ergo_tree,
            tokens: None,
            additional_registers: NonMandatoryRegisters::empty(),
            creation_height: 1,
        };

        // ----- Step 2: build the transaction. -----
        // The input spends the seeded emission box. After T7 (genesis
        // special-case removal) the walker REMOVEs this entry from the
        // sidecar via standard semantics; the lookup MUST find it.
        let emission_box_id_typed: BoxId = Digest::from(emission_id).into();
        let input = Input::new(
            emission_box_id_typed.clone(),
            ProverResult {
                proof: ProofBytes::Empty,
                extension: ContextExtension::empty(),
            },
        );
        let tx = Transaction::new_from_vec(
            vec![input],
            vec![],
            vec![output_candidate.clone()],
        )
        .expect("build tx");

        // ----- Step 3: serialize the transaction. -----
        let tx_bytes = tx.sigma_serialize_bytes().expect("serialize tx");

        // ----- Step 4: hand-craft a v2 Header. -----
        // tx_root / ext_root are NOT cryptographically meaningful
        // here — `ingest_block` only READS these fields to derive
        // modifier IDs via `prefixed_hash`. Any 32-byte value works
        // as long as the same value is used to compute the modifier
        // IDs we put() under.
        let tx_root: [u8; 32] = blake2b256_hash(&tx_bytes).0;
        // Pre-craft the empty Extension payload so we know what
        // ext_root to bake in (we use a content-addressed value just
        // to keep the test internally consistent — the field isn't
        // load-bearing for ingest_block's correctness).
        let empty_ext_payload = {
            let mut v: Vec<u8> = Vec::new();
            // (We'll compute the full bytes including header_id once
            // we know the header_id; for the ext_root we only need
            // to commit to SOMETHING, so use the tag-only bytes.)
            WriteSigmaVlqExt::put_u32(&mut v, 0u32).expect("write 0 field_count");
            v
        };
        let ext_root: [u8; 32] = blake2b256_hash(&empty_ext_payload).0;

        let header = Header {
            version: 2,
            // id gets recomputed by scorex_parse so it can be a
            // placeholder zero here.
            id: BlockId(Digest32::zero()),
            parent_id: BlockId(Digest32::zero()),
            ad_proofs_root: Digest::from([0x42u8; 32]),
            state_root: Digest::from([0x42u8; 33]),
            transaction_root: Digest::from(tx_root),
            timestamp: 1_500_000_000_000,
            n_bits: 0x1d00ffff,
            height: GENESIS_HEIGHT,
            extension_root: Digest::from(ext_root),
            autolykos_solution: AutolykosSolution {
                miner_pk: Box::new(ec_point::generator()),
                pow_onetime_pk: None,
                nonce: vec![0u8; 8],
                pow_distance: None,
            },
            votes: Votes([0u8, 0u8, 0u8]),
            unparsed_bytes: Box::new([]),
        };

        // ----- Step 5: serialize the header. -----
        let header_bytes = header.scorex_serialize_bytes().expect("serialize header");

        // Re-derive the canonical header_id by running the header
        // bytes back through scorex_parse — sigma-rust computes it
        // by hashing serialize_without_pow + solution_bytes. This is
        // the value `best_header_at` will return from BEST_CHAIN.
        let parsed_header = Header::scorex_parse_bytes(&header_bytes).expect("re-parse");
        let header_id: [u8; 32] = parsed_header.id.0.0;

        // ----- Step 6: write everything into a temp redb store. -----
        let store_dir = TempDir::new().expect("store tempdir");
        let store_path = store_dir.path().join("modifiers.redb");
        let store = RedbModifierStore::new(&store_path).expect("open temp store");

        // Score: a single non-zero byte is sufficient; the store
        // doesn't interpret it on the read paths ingest_block uses.
        store
            .put_header(&header_id, GENESIS_HEIGHT, 0, &[0x01u8], &header_bytes)
            .expect("put_header");

        // BlockTransactions wire format: header_id (32B) ||
        // tx_count_vlq || serialized_txs. Block version <= 1 sentinel
        // path is the simpler one (no version embedded).
        let block_tx_payload = {
            let mut v = Vec::new();
            v.extend_from_slice(&header_id);
            // tx_count = 1, encoded as plain (non-sentinel) VLQ.
            WriteSigmaVlqExt::put_u32(&mut v, 1u32).expect("write tx_count");
            v.extend_from_slice(&tx_bytes);
            v
        };
        let block_tx_id = prefixed_hash(BLOCK_TRANSACTIONS_TYPE_ID, &header_id, &tx_root);
        store
            .put(BLOCK_TRANSACTIONS_TYPE_ID, &block_tx_id, GENESIS_HEIGHT, &block_tx_payload)
            .expect("put block_tx");

        // Extension wire format: header_id (32B) || field_count_vlq
        //  || fields. We use field_count = 0.
        let ext_payload = {
            let mut v = Vec::new();
            v.extend_from_slice(&header_id);
            v.extend_from_slice(&empty_ext_payload);
            v
        };
        let ext_id = prefixed_hash(EXTENSION_TYPE_ID, &header_id, &ext_root);
        store
            .put(EXTENSION_TYPE_ID, &ext_id, GENESIS_HEIGHT, &ext_payload)
            .expect("put extension");

        // ----- Step 7: open a sidecar SEEDED with the 3 genesis boxes. -----
        // This mirrors what main.rs:154 does in production via T5a.
        // Without the seed, the walker's REMOVE of the emission box at
        // step 8 would miss with WalkerError::MissingUtxo.
        let sidecar_dir = TempDir::new().expect("sidecar tempdir");
        let sidecar_path = sidecar_dir.path().join("utxo-index.redb");
        let sidecar = UtxoIndex::open_or_create(&sidecar_path, &header_id, &genesis_seed)
            .expect("open sidecar with genesis seed");

        // ----- Step 8: invoke ingest_block end-to-end. -----
        let bundle = ingest_block(GENESIS_HEIGHT, &store, &sidecar).expect("ingest_block");

        // ----- Step 9: shape assertions on the returned bundle. -----
        assert_eq!(bundle.height, GENESIS_HEIGHT, "bundle height");
        assert_eq!(bundle.block_id, header_id, "bundle block_id");
        assert_eq!(bundle.parent_id, [0u8; 32], "bundle parent_id (synthetic genesis)");
        assert_eq!(bundle.header_bytes, header_bytes, "bundle header_bytes verbatim");
        assert_eq!(bundle.transactions.len(), 1, "one transaction");
        let tx_bundle = &bundle.transactions[0];
        assert_eq!(tx_bundle.tx_id, tx.id().0.0, "tx_id matches sigma-rust id()");
        assert_eq!(tx_bundle.inputs.len(), 1, "one input");
        assert_eq!(
            tx_bundle.inputs[0].box_id, emission_id,
            "input box_id is the emission box id from the seed"
        );
        assert_eq!(
            tx_bundle.inputs[0].spent_box_bytes, emission_bytes,
            "input spent_box_bytes matches the seeded emission box (REMOVE captured it)"
        );

        // The other 2 genesis boxes (no_premine, founders) were
        // untouched by this synthetic block; they remain in the sidecar.
        assert_eq!(
            sidecar.get(&no_premine_id).expect("get no_premine"),
            Some(no_premine_bytes),
            "no_premine still in sidecar"
        );
        assert_eq!(
            sidecar.get(&founders_id).expect("get founders"),
            Some(founders_bytes),
            "founders still in sidecar"
        );
        // Emission box is gone (REMOVE happened).
        assert_eq!(
            sidecar.get(&emission_id).expect("get emission"),
            None,
            "emission box removed by the walker"
        );
        assert_eq!(tx_bundle.outputs.len(), 1, "one output");
        // The output bytes the walker captured must match what
        // ErgoBox::sigma_serialize would emit for the output (the
        // walker re-derives the bytes from the parsed tx, so this
        // also covers the per-output insert).
        let parsed_output = tx
            .outputs
            .iter()
            .next()
            .expect("at least one output in parsed tx");
        let expected_output_bytes =
            parsed_output.sigma_serialize_bytes().expect("ser output");
        assert_eq!(
            tx_bundle.outputs[0], expected_output_bytes,
            "output bytes match the serialized ErgoBox"
        );

        // ----- Step 10: verify the sidecar INSERT actually happened. -----
        // The walker just put this output into the index; a `get` by
        // its canonical box_id must come back with the same bytes.
        let output_box_id: [u8; 32] = parsed_output
            .box_id()
            .as_ref()
            .try_into()
            .expect("box_id is 32 bytes");
        let index_lookup = sidecar.get(&output_box_id).expect("sidecar.get");
        assert_eq!(
            index_lookup,
            Some(expected_output_bytes),
            "sidecar boxes table populated with the output bytes"
        );

        // Parameters: empty extension means no max_block_cost field
        // was present; ingest_block emits None in that case.
        assert!(
            bundle.parameters.is_none(),
            "empty extension produces parameters = None"
        );
    }
}
