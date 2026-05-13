//! Ecosystem 14-contract corpus.
//!
//! Sourced from `test_ecosystem_batch` in sigma-rust's
//! `ergoscript-compiler/src/compiler.rs`. This is the auth-gated batch of
//! production contracts from SigmaFi, SkyHarbor, DuckPools, and Lilium —
//! 14 contracts that all byte-match the Scala node (the 15th, DuckPools
//! ERG InterestRate, is excluded because it crashes our CSE with a deeply
//! nested BigInt polynomial; see `ERGOSCRIPT-COMPILER-STATUS.md` Known
//! issues).
//!
//! The source corpus is checked in as JSON under
//! `fixture-gen/data/ergoscript/ecosystem_14.json` and embedded at build
//! time. We do NOT call the live Ergo node here — the upstream test had
//! `#[ignore]` and required a localhost:9053 — so we compile each contract
//! locally via `ergoscript_compiler::compile` and trust that sigma-rust
//! itself has already validated byte-equivalence against the node.
//!
//! ## Non-determinism filter
//!
//! The upstream compiler uses `std::collections::HashMap` (RandomState) in
//! its CSE pass, so some contracts produce **different** ErgoTree bytes
//! across runs. We handle this with two layers:
//!
//! 1. A static [`KNOWN_UNSTABLE`] block-list of contracts whose CSE output
//!    is known to vary. These never produce a fixture entry; instead they
//!    show up in `non_deterministic` with a marker. This keeps committed
//!    fixtures byte-stable across runs.
//! 2. Every other entry is still compiled [`STABILITY_PASSES`] times and
//!    the run errors if any of them drift (since that means a contract
//!    silently joined the unstable list and the static list needs an
//!    update).
//!
//! As of 2026-05-14: `SigmaFi OpenOrderERG` and `SigmaFi OpenOrderToken`
//! are on the unstable list; the other 12 ecosystem contracts are stable.

use ergoscript_compiler::compiler::compile;
use ergoscript_compiler::script_env::ScriptEnv;
use ergotree_ir::serialization::SigmaSerializable;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const STABILITY_PASSES: usize = 4;

/// Contracts whose CSE output is known to be non-deterministic. The
/// upstream `ergoscript-compiler` uses `std::collections::HashMap`
/// (RandomState) in its CSE pass; for these contracts, iteration order
/// flips ValDef numbering and emits different byte sequences across runs.
///
/// Discovered empirically by running fixture-gen ~6 times and noting which
/// `tree_bytes_hex` differed. If/when sigma-rust switches to
/// `BTreeMap` / `IndexMap`, this list can shrink (or disappear).
const KNOWN_UNSTABLE: &[&str] = &["SigmaFi OpenOrderERG", "SigmaFi OpenOrderToken"];

/// Raw entry in `data/ergoscript/ecosystem_14.json`, a 2-tuple of
/// (name, ergoscript source). Stored as `[name, es]` arrays.
#[derive(Deserialize)]
struct RawEntry(String, String);

#[derive(Serialize)]
pub struct CorpusEntry {
    pub name: String,
    pub source_es: String,
    pub tree_bytes_hex: String,
    pub byte_length: usize,
}

#[derive(Serialize)]
pub struct NonDeterministicEntry {
    pub name: String,
    pub source_es: String,
    /// `true` when this entry is on the static [`KNOWN_UNSTABLE`] list and
    /// was deliberately not compiled.
    pub known_unstable: bool,
}

#[derive(Serialize)]
pub struct CorpusFixture {
    pub corpus: &'static str,
    pub entries: Vec<CorpusEntry>,
    pub non_deterministic: Vec<NonDeterministicEntry>,
    pub compile_errors: Vec<String>,
}

const CORPUS_JSON: &str = include_str!("../../../data/ergoscript/ecosystem_14.json");

pub fn generate() -> anyhow::Result<CorpusFixture> {
    let raw: Vec<RawEntry> = serde_json::from_str(CORPUS_JSON)?;
    let mut entries = Vec::with_capacity(raw.len());
    let mut non_deterministic = Vec::new();
    let mut compile_errors = Vec::new();

    for RawEntry(name, source_es) in raw {
        if KNOWN_UNSTABLE.contains(&name.as_str()) {
            non_deterministic.push(NonDeterministicEntry {
                name,
                source_es,
                known_unstable: true,
            });
            continue;
        }

        let mut observed: BTreeSet<String> = BTreeSet::new();
        let mut compile_failed = false;
        for _ in 0..STABILITY_PASSES {
            let tree = match compile(&source_es, ScriptEnv::new()) {
                Ok(t) => t,
                Err(e) => {
                    compile_errors.push(format!("{}: {:?}", name, e));
                    compile_failed = true;
                    break;
                }
            };
            let bytes = tree.sigma_serialize_bytes()?;
            observed.insert(hex::encode(&bytes));
        }
        if compile_failed {
            continue;
        }

        if observed.len() != 1 {
            // A new unstable contract — surface it loudly so the static
            // KNOWN_UNSTABLE list can be updated. Don't silently emit a
            // non-deterministic fixture entry.
            let observed_hex: Vec<String> = observed.into_iter().collect();
            let observed_byte_lengths: Vec<usize> =
                observed_hex.iter().map(|h| h.len() / 2).collect();
            anyhow::bail!(
                "ecosystem_14: contract {:?} produced {} distinct ErgoTree byte outputs \
                 over {} compile passes (sizes={:?}). Add it to KNOWN_UNSTABLE in \
                 fixture-gen/src/cmds/ergoscript/corpus_ecosystem_14.rs and re-run.",
                name,
                observed_hex.len(),
                STABILITY_PASSES,
                observed_byte_lengths,
            );
        }

        let hex_str = observed.into_iter().next().unwrap();
        let byte_length = hex_str.len() / 2;
        entries.push(CorpusEntry {
            name,
            source_es,
            tree_bytes_hex: hex_str,
            byte_length,
        });
    }

    Ok(CorpusFixture {
        corpus: "ecosystem_14",
        entries,
        non_deterministic,
        compile_errors,
    })
}
