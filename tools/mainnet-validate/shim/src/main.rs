//! Shim subprocess for the ergots mainnet validation harness.
//!
//! Reads `modifiers.redb` from argv[1] (read-only at the protocol level —
//! the shim never writes to the source store; `enr-store`'s constructor is
//! a single `RedbModifierStore::new` that opens-or-creates the database
//! file). The sidecar at argv[2] is OPENED FOR WRITE — it's the shim's
//! private UTXO index (per spec Decision 11) and is owned exclusively by
//! the running shim process.
//!
//! T2 scope (already shipped):
//! - Argv parsing for the store path.
//! - Startup full-archive check: tip(101) (Header) and tip(102)
//!   (BlockTransactions). Empty store or a tip(102) gap from tip(101) of
//!   more than 1000 blocks indicates a utxo_bootstrap-only node.
//! - Stdin read loop with stub response.
//!
//! T3 added:
//! - Second positional argv: sidecar path.
//! - Sidecar open-or-create with source-store fingerprint check (auto-rebuild
//!   on mismatch per spec Open item #4).
//! - GET_TIP_HEIGHT handler: returns `tip(101)` as `{ok: true, data: {tip}}`.
//! - GET_BLOCK stub: emitted `not-implemented` until T4/T5 wired it.
//!
//! T4 added:
//! - GET_BLOCK <height> handler emitting a header-only BlockBundle (height,
//!   block_id, parent_id, header_bytes, transactions=[]). Parent id is
//!   extracted from `header_bytes[1..33]` per the Header wire format,
//!   avoiding a sigma-rust dep at T4 (deferred to T5 with the rest of the
//!   BlockTransactions / Extension parsing).
//! - Missing-block error path: `best_header_at(h)` returning None emits
//!   `{ok: false, error: {code: "missing-block", ...}}` without exiting
//!   the loop.
//!
//! T5 adds (this task):
//! - Forward-walking UTXO ingestion. GET_BLOCK <H> walks every height
//!   from `sidecar.indexed_up_to_height + 1` to `H`, ingesting each
//!   block's BlockTransactions and Extension into the sidecar. The
//!   block at `H` is the one returned in the BlockBundle; intermediate
//!   bundles are discarded but their index mutations persist.
//! - Full TxBundle population (signing_message, inputs, outputs,
//!   data_input_boxes) per `block_walker::ingest_block`.
//! - Extension parameter extraction (max_block_cost surfaced via
//!   `BlockBundle::parameters`).
//! - `missing-utxo` error code when an input references an absent
//!   index entry — propagated as a wire error without exiting the loop.
//!
//! Per spec docs/specs/2026-05-21-mainnet-validate-harness-design.md
//! Decisions 3, 6, 7, 8, 11.

mod block_walker;
mod genesis_constants;
mod protocol;
mod utxo_index;

use std::io::{self, BufRead};
use std::path::Path;
use std::process::ExitCode;

use anyhow::{Context, Result};
use enr_store::{ModifierStore, RedbModifierStore};

use crate::protocol::TipHeightResponse;
use crate::utxo_index::UtxoIndex;

/// Modifier type IDs (per `ergo-node-rust/chain/src/section.rs:12-15`).
const HEADER_TYPE_ID: u8 = 101;
const BLOCK_TRANSACTIONS_TYPE_ID: u8 = 102;

/// Threshold for the bootstrap-gap heuristic. A header tip more than
/// `BOOTSTRAP_GAP_THRESHOLD` blocks ahead of the BlockTransactions tip
/// indicates a `utxo_bootstrap = true` node (validator created after a
/// snapshot download; no automatic backfill of the snapshot-prior range).
/// A small gap (e.g. validator one block behind during normal sync) is
/// not flagged.
const BOOTSTRAP_GAP_THRESHOLD: u32 = 1000;

/// Outcome of the startup full-archive check.
enum StartupOutcome {
    /// Store passes the full-archive heuristic; proceed into the stdin loop.
    Ok,
    /// The store is empty or appears to be a utxo_bootstrap'd node. A
    /// structured error response has already been written to stdout; the
    /// caller exits 1 without printing anything else.
    Halt,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(StartupOrIoError::Startup) => {
            // A structured CBOR error has already been written to stdout.
            // Exit 1 silently — no stderr duplication of the same message.
            ExitCode::FAILURE
        }
        Err(StartupOrIoError::Io(e)) => {
            // Last-resort error reporter for failures BEFORE the protocol
            // framing is established (e.g. missing argv, store path
            // unreadable). Print to stderr so the harness can capture it
            // separately from stdout, which is reserved for the CBOR frame.
            eprintln!("ergots-mainnet-validate-shim: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Top-level fallible runner. `StartupOrIoError::Startup` signals that the
/// startup check already emitted a structured error and the caller should
/// exit silently; any other failure mode flows through `Io` and gets an
/// eprintln of its anyhow chain.
enum StartupOrIoError {
    Startup,
    Io(anyhow::Error),
}

impl<E: Into<anyhow::Error>> From<E> for StartupOrIoError {
    fn from(e: E) -> Self {
        StartupOrIoError::Io(e.into())
    }
}

fn run() -> Result<(), StartupOrIoError> {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: ergots-mainnet-validate-shim <modifiers.redb path> <sidecar.redb path>";
    let store_path = args.get(1).context(usage)?;
    let sidecar_path = args.get(2).context(usage)?;

    let store = RedbModifierStore::new(Path::new(store_path))
        .with_context(|| format!("opening modifier store at {store_path}"))?;

    match startup_check(&store)? {
        StartupOutcome::Halt => return Err(StartupOrIoError::Startup),
        StartupOutcome::Ok => {}
    }

    // Compute the source-store fingerprint and open (or rebuild) the
    // sidecar. Genesis HEADER_ID = blake2b256(genesis_header_bytes) is
    // itself a 32-byte chain-discriminator: differs across chains
    // (mainnet vs testnet vs custom), stable for any progressed copy of
    // the same chain. We use the precomputed id (already in BEST_CHAIN
    // at height 1) rather than re-hashing the header bytes — same
    // discriminating power, no hash-crate dep, and `best_header_at(1)`
    // is the canonical "give me the genesis id" call (Ergo genesis is
    // at height 1, per `ergo-node-rust/chain/src/chain.rs:85`).
    let source_store_hash = store
        .best_header_at(1)
        .context("reading genesis header id (best_header_at(1)) for sidecar fingerprint")?
        .context(
            "store.redb has no header at height 1 — cannot derive sidecar source-store \
             fingerprint. This is unreachable under the startup full-archive check \
             (which already required tip(101) >= 1), but is reported here as a safety \
             net against future refactors of startup_check",
        )?;

    let sidecar = UtxoIndex::open_or_create(Path::new(sidecar_path), &source_store_hash)
        .with_context(|| format!("opening sidecar UTXO index at {sidecar_path}"))?;
    let indexed_height = sidecar
        .indexed_up_to_height()
        .context("reading sidecar indexed_up_to_height marker")?;
    eprintln!("sidecar opened at height {indexed_height}");

    stdin_loop(&store, &sidecar)?;
    Ok(())
}

/// Reads stdin line-by-line; dispatches each request to its handler.
///
/// `sidecar` is passed through to `handle_get_block` for the
/// forward-walking UTXO ingestion (T5).
fn stdin_loop(store: &RedbModifierStore, sidecar: &UtxoIndex) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.context("reading from stdin")?;
        match protocol::parse_request(&line) {
            Ok(protocol::Request::GetTipHeight) => {
                let tip = store
                    .tip(HEADER_TYPE_ID)
                    .context("querying tip for type 101 (Header) during GET_TIP_HEIGHT")?;
                // Startup check rejected the empty-store case, so a
                // None tip here would be a chain-meta race or external
                // mutation. Either way the harness should see it.
                match tip {
                    Some((h, _)) => {
                        protocol::write_ok(&mut stdout, TipHeightResponse { tip: h })
                            .context("writing GET_TIP_HEIGHT response")?;
                    }
                    None => {
                        protocol::write_err(
                            &mut stdout,
                            "empty-store",
                            "tip(101) returned None during GET_TIP_HEIGHT despite \
                             startup check passing; the store appears to have been \
                             cleared since open",
                        )
                        .context("writing GET_TIP_HEIGHT empty-store error")?;
                    }
                }
            }
            Ok(protocol::Request::GetBlock { height }) => {
                handle_get_block(store, sidecar, &mut stdout, height)
                    .with_context(|| format!("handling GET_BLOCK {height}"))?;
            }
            Err(msg) => {
                protocol::write_err(&mut stdout, "unknown-command", &msg)
                    .context("writing unknown-command error")?;
            }
        }
    }
    Ok(())
}

/// Handle a single GET_BLOCK <height> request: walk forward from the
/// sidecar's `indexed_up_to_height + 1` to `height`, populating the
/// UTXO index along the way, and emit the assembled BlockBundle for
/// `height`.
///
/// The handler does NOT exit the stdin loop on a missing-height or
/// ingestion error — it emits the CBOR error and returns Ok so the
/// loop can serve further requests. Only IO errors writing to stdout
/// (broken pipe, harness died) propagate up to terminate the shim.
///
/// Error codes emitted on the wire (consumed by the harness). Each
/// corresponds to a `WalkerError` variant (or a pre-walker pre-flight
/// check); the dispatch in `handle_get_block` is a typed match, NOT a
/// substring scan over the rendered anyhow chain — see T5 quality
/// review for the historical bug (`"missing-data-utxo"` contains
/// `"missing-utxo"` as a substring, so the old dispatch never reached
/// the data-utxo branch).
///
/// - `missing-block`: `best_header_at(h)` for some h in
///   `indexed+1..=height` returned None (past tip, or a hole in
///   BEST_CHAIN we never expected to encounter). Emitted by the
///   pre-flight check in this function, NOT by the walker.
/// - `store-race`: `best_header_at` returned Some but a subsequent
///   `read_header_at` returned None — a store concurrent-mutation
///   smell. Emitted both by the pre-flight check here and by the
///   walker if the race happens between the pre-flight and the per-
///   block read.
/// - `missing-utxo` / `missing-data-utxo`: a tx input or data input
///   referenced a box that wasn't in the index. Could mean the index
///   is stale (rebuild needed), the walker has a bug, or the source
///   store has chain data inconsistent with its own header sequence.
/// - `missing-section`: BlockTransactions or Extension modifier
///   absent from the store at a height where BEST_CHAIN claims a
///   header. Distinct from `missing-block` because the header DOES
///   exist; it's the secondary section that's gone.
/// - `walker-error`: generic catch-all when ingestion fails for some
///   other reason (sigma-rust parse failure, malformed Extension,
///   blake2 hash mismatch in derived modifier id, etc.). The message
///   carries the anyhow chain via `WalkerError::message()`.
fn handle_get_block(
    store: &RedbModifierStore,
    sidecar: &UtxoIndex,
    stdout: &mut impl io::Write,
    height: u32,
) -> Result<()> {
    // Pre-flight: confirm the *target* height exists in BEST_CHAIN
    // before we burn any sidecar writes on intermediate heights. If
    // the caller asked for a height past the tip, surface that as
    // `missing-block` without doing the walk. We also do a paired
    // `read_header_at` here so a BEST_CHAIN-says-yes-but-PRIMARY-
    // says-no inconsistency surfaces as `store-race` rather than
    // disappearing under a generic walker error mid-loop.
    let target_header_id = store
        .best_header_at(height)
        .with_context(|| format!("best_header_at({height})"))?;
    if target_header_id.is_none() {
        let msg = format!(
            "no canonical header at height {height}; possibly past tip"
        );
        protocol::write_err(stdout, "missing-block", &msg)
            .context("writing missing-block error")?;
        return Ok(());
    }
    // Pre-flight store-race check: BEST_CHAIN points to a header but
    // PRIMARY (which `read_header_at` consults) doesn't. The race is
    // benign for the *next* call (a retry usually wins), but emitting
    // a distinct wire code lets the harness avoid trying to repair
    // the index for a transient store-mutation window.
    let target_header_bytes = store
        .read_header_at(height)
        .with_context(|| format!("read_header_at({height}) preflight"))?;
    if target_header_bytes.is_none() {
        let msg = format!(
            "best_header_at({height}) returned Some but read_header_at({height}) \
             returned None — likely concurrent store mutation between the two \
             reads. Retry the call once the writer settles."
        );
        protocol::write_err(stdout, "store-race", &msg)
            .context("writing store-race error")?;
        return Ok(());
    }

    let indexed = sidecar
        .indexed_up_to_height()
        .context("reading sidecar indexed_up_to_height marker before walk")?;

    if height <= indexed {
        // Block already past the indexed point — the index has already
        // been advanced past this height (and the bundle's spent-box
        // bytes for inputs are no longer in the index, since they were
        // REMOVED at the producing block). We could in principle
        // re-derive them by walking from genesis, but the spec lifts
        // this responsibility to the *caller*: the harness walks
        // monotonically forward, never backward, and a request at or
        // below `indexed` is a usage error. Surface that distinctly so
        // a future harness bug is loud.
        let msg = format!(
            "GET_BLOCK {height}: requested height is at or below sidecar.indexed_up_to_height={indexed}; \
             the forward walker cannot serve already-past heights"
        );
        protocol::write_err(stdout, "past-indexed", &msg)
            .context("writing past-indexed error")?;
        return Ok(());
    }

    // Walk forward through each intermediate height. For the target
    // height we keep the bundle; for intermediates we discard but
    // persist the index mutation.
    let mut final_bundle: Option<protocol::BlockBundle> = None;
    for h in (indexed + 1)..=height {
        // Confirm BEST_CHAIN coverage at h before invoking the walker,
        // so we can emit a precise wire error if the chain has a hole.
        let id_at_h = store
            .best_header_at(h)
            .with_context(|| format!("best_header_at({h}) during walk"))?;
        if id_at_h.is_none() {
            let msg = format!(
                "walk to {height} hit a missing canonical header at intermediate height {h}"
            );
            protocol::write_err(stdout, "missing-block", &msg)
                .context("writing missing-block error during walk")?;
            return Ok(());
        }

        match block_walker::ingest_block(h, store, sidecar) {
            Ok(bundle) => {
                if h == height {
                    final_bundle = Some(bundle);
                }
                sidecar
                    .set_indexed_up_to_height(h)
                    .with_context(|| format!("advancing indexed_up_to_height to {h}"))?;
            }
            Err(walker_err) => {
                // Dispatch on the typed `WalkerError` variant rather
                // than substring-matching the rendered anyhow chain.
                // Substring matching was the original implementation
                // and was wrong: `"missing-data-utxo"` contains the
                // substring `"missing-utxo"`, so the second branch
                // was unreachable under that scheme. See T5 quality
                // review for the bug walkthrough.
                let code = walker_err.code();
                let msg = format!("ingest_block({h}): {}", walker_err.message());
                protocol::write_err(stdout, code, &msg)
                    .context("writing walker error")?;
                return Ok(());
            }
        }
    }

    let bundle = final_bundle.expect(
        "loop ran with height >= indexed + 1, so final_bundle must be set when h == height",
    );

    protocol::write_ok(stdout, &bundle).context("writing GET_BLOCK response")?;
    Ok(())
}

/// Runs the startup full-archive check. On detection of an empty store or
/// a utxo_bootstrap'd node, writes a CBOR-framed error message on stdout
/// and returns `StartupOutcome::Halt`. Otherwise returns `Ok`.
fn startup_check(store: &RedbModifierStore) -> Result<StartupOutcome> {
    let header_tip = store
        .tip(HEADER_TYPE_ID)
        .context("querying tip for type 101 (Header)")?;
    let txs_tip = store
        .tip(BLOCK_TRANSACTIONS_TYPE_ID)
        .context("querying tip for type 102 (BlockTransactions)")?;

    let mut stdout = io::stdout().lock();

    let header_height = match header_tip {
        Some((h, _)) => h,
        None => {
            protocol::write_err(
                &mut stdout,
                "empty-store",
                "store has no Headers (type 101); node has not synced any blocks",
            )
            .context("writing empty-store error")?;
            return Ok(StartupOutcome::Halt);
        }
    };

    let txs_height = txs_tip.map(|(h, _)| h).unwrap_or(0);

    if header_height.saturating_sub(txs_height) > BOOTSTRAP_GAP_THRESHOLD {
        let msg = format!(
            "BlockTransactions tip ({txs_height}) is significantly lower than \
             Header tip ({header_height}); likely utxo_bootstrap = true. The \
             validation harness's forward-walking UTXO index requires \
             BlockTransactions from genesis."
        );
        protocol::write_err(&mut stdout, "utxo-bootstrap-detected", &msg)
            .context("writing utxo-bootstrap-detected error")?;
        return Ok(StartupOutcome::Halt);
    }

    Ok(StartupOutcome::Ok)
}
