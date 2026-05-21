//! Shim subprocess for the ergots mainnet validation harness.
//!
//! Reads `modifiers.redb` from argv[1] (read-only at the protocol level —
//! T2 never calls a write API; `enr-store`'s constructor is a single
//! `RedbModifierStore::new` that opens-or-creates the database file).
//!
//! T2 scope:
//! - Argv parsing (positional store path required).
//! - Startup full-archive check: tip(101) (Header) and tip(102)
//!   (BlockTransactions). Empty store or a tip(102) gap from tip(101) of
//!   more than 1000 blocks indicates a utxo_bootstrap-only node and is
//!   reported via `{ok: false, error: ...}` followed by exit 1.
//! - Stdin read loop: each request parses via protocol::parse_request,
//!   but T2 only emits a stub success response (no GET_TIP_HEIGHT /
//!   GET_BLOCK logic yet — T3 / T4 / T5).
//!
//! Per spec docs/specs/2026-05-21-mainnet-validate-harness-design.md
//! Decisions 3, 6, 7, 8.

mod protocol;

use std::io::{self, BufRead};
use std::path::Path;
use std::process::ExitCode;

use anyhow::{Context, Result};
use enr_store::{ModifierStore, RedbModifierStore};

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
    let store_path = args
        .get(1)
        .context("usage: ergots-mainnet-validate-shim <modifiers.redb path>")?;

    let store = RedbModifierStore::new(Path::new(store_path))
        .with_context(|| format!("opening modifier store at {store_path}"))?;

    match startup_check(&store)? {
        StartupOutcome::Halt => return Err(StartupOrIoError::Startup),
        StartupOutcome::Ok => {}
    }

    stdin_loop()?;
    Ok(())
}

/// Reads stdin line-by-line; for each line emits a T2 stub response.
///
/// T3-T5 replace the inner branch with real dispatch on `Request`.
fn stdin_loop() -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.context("reading from stdin")?;
        match protocol::parse_request(&line) {
            Ok(_request) => {
                // T2 stub: emit `{ok: true, data: "stub"}`. Real handlers
                // for GetTipHeight and GetBlock arrive in T3 / T4 / T5.
                protocol::write_ok(&mut stdout, "stub")
                    .context("writing stub response")?;
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
