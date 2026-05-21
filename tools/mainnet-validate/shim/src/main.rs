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
//! T3 adds (this task):
//! - Second positional argv: sidecar path.
//! - Sidecar open-or-create with source-store fingerprint check (auto-rebuild
//!   on mismatch per spec Open item #4).
//! - GET_TIP_HEIGHT handler: returns `tip(101)` as `{ok: true, data: {tip}}`.
//! - GET_BLOCK stub: emits `not-implemented` until T4/T5 wire it.
//!
//! Per spec docs/specs/2026-05-21-mainnet-validate-harness-design.md
//! Decisions 3, 6, 7, 8, 11.

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
/// `sidecar` is borrowed but not actually written-to in T3 (only
/// GET_TIP_HEIGHT is wired; GET_BLOCK is stubbed). T5's GET_BLOCK
/// handler will be the first writer of the sidecar's box table.
fn stdin_loop(store: &RedbModifierStore, _sidecar: &UtxoIndex) -> Result<()> {
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
            Ok(protocol::Request::GetBlock { .. }) => {
                // T4/T5 will replace this with the real walk-and-bundle
                // logic; surfacing "not-implemented" here makes the
                // failure mode obvious if a harness in T3-era is
                // accidentally pointed at GET_BLOCK.
                protocol::write_err(
                    &mut stdout,
                    "not-implemented",
                    "GET_BLOCK is implemented at T4 (header-only) and T5 (full bundle); \
                     T3 only ships GET_TIP_HEIGHT and the sidecar scaffolding",
                )
                .context("writing GET_BLOCK not-implemented error")?;
            }
            Err(msg) => {
                protocol::write_err(&mut stdout, "unknown-command", &msg)
                    .context("writing unknown-command error")?;
            }
        }
    }
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
