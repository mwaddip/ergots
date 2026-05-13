//! Significant-15 contract corpus.
//!
//! Sourced from `tests/fixtures/significant_15/` in sigma-rust. These are
//! 15 keystone contracts from major Ergo protocols (chaincash, dexy,
//! duckpools, oracle, rosen, sigmao, skyharbor, spectrum, ergomixer,
//! ergoraffle, gluon, phoenix, paideia, sigmausd, spectrum-t2t).
//!
//! Each fixture is a `.es` file. Some are self-contained; others reference
//! free identifiers (e.g. `tokenId`, `oraclePoolNFT`) that the upstream
//! Scala scope binds via env. We pre-inject those bindings as a `prelude`
//! at the start of the outer block, mirroring what `test_significant_15`
//! does in sigma-rust. The fully-prepared source is serialized into the
//! data JSON at build time so this module can be deterministic without
//! reaching out to the live filesystem.
//!
//! Per the upstream MANIFEST: 9 of 15 byte-match against the Scala node,
//! 6 use a local compile / `compile_canonical` node fallback. We compile
//! all 15 locally here; the TS corpus test asserts round-trip parity
//! against our own compiled bytes.
//!
//! ## Non-determinism filter
//!
//! See `corpus_ecosystem_14.rs` for context. We maintain a static
//! [`KNOWN_UNSTABLE`] block-list of contracts whose CSE output drifts
//! across runs; they never produce a fixture entry (just a marker in
//! `non_deterministic`). Every other contract is compiled
//! [`STABILITY_PASSES`] times to verify byte-stability; if any drift is
//! detected on a contract NOT on the list, fixture-gen errors out so the
//! list can be updated.
//!
//! As of 2026-05-14: `oracle_refresh`, `paideia_stake_state`, and
//! `sigmausd_bank` are on the unstable list; the other 12 are stable.

use ergoscript_compiler::compiler::compile;
use ergoscript_compiler::script_env::ScriptEnv;
use ergotree_ir::serialization::SigmaSerializable;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const STABILITY_PASSES: usize = 4;

/// Contracts on the upstream compiler's CSE-non-determinism block-list.
/// See the equivalent constant in `corpus_ecosystem_14.rs` for the
/// rationale (`std::collections::HashMap` randomization in CSE).
const KNOWN_UNSTABLE: &[&str] = &["oracle_refresh", "paideia_stake_state", "sigmausd_bank"];

#[derive(Deserialize)]
struct RawEntry {
    name: String,
    fixture_path: String,
    prelude: String,
    es: String,
}

#[derive(Serialize)]
pub struct CorpusEntry {
    pub name: String,
    /// Filename of the `.es` fixture in
    /// `sigma-rust/ergoscript-compiler/tests/fixtures/significant_15/`.
    pub fixture_path: String,
    /// Val-declarations prepended into the source's outer block. Empty if
    /// the source is self-contained.
    pub prelude: String,
    /// The full prepared ErgoScript source after prelude injection.
    pub source_es: String,
    pub tree_bytes_hex: String,
    pub byte_length: usize,
}

#[derive(Serialize)]
pub struct NonDeterministicEntry {
    pub name: String,
    pub fixture_path: String,
    pub prelude: String,
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

const CORPUS_JSON: &str = include_str!("../../../data/ergoscript/significant_15.json");

pub fn generate() -> anyhow::Result<CorpusFixture> {
    let raw: Vec<RawEntry> = serde_json::from_str(CORPUS_JSON)?;
    let mut entries = Vec::with_capacity(raw.len());
    let mut non_deterministic = Vec::new();
    let mut compile_errors = Vec::new();

    for r in raw {
        if KNOWN_UNSTABLE.contains(&r.name.as_str()) {
            non_deterministic.push(NonDeterministicEntry {
                name: r.name,
                fixture_path: r.fixture_path,
                prelude: r.prelude,
                source_es: r.es,
                known_unstable: true,
            });
            continue;
        }

        let mut observed: BTreeSet<String> = BTreeSet::new();
        let mut compile_failed = false;
        for _ in 0..STABILITY_PASSES {
            let tree = match compile(&r.es, ScriptEnv::new()) {
                Ok(t) => t,
                Err(e) => {
                    compile_errors.push(format!("{}: {:?}", r.name, e));
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
            let observed_hex: Vec<String> = observed.into_iter().collect();
            let observed_byte_lengths: Vec<usize> =
                observed_hex.iter().map(|h| h.len() / 2).collect();
            anyhow::bail!(
                "significant_15: contract {:?} produced {} distinct ErgoTree byte outputs \
                 over {} compile passes (sizes={:?}). Add it to KNOWN_UNSTABLE in \
                 fixture-gen/src/cmds/ergoscript/corpus_significant_15.rs and re-run.",
                r.name,
                observed_hex.len(),
                STABILITY_PASSES,
                observed_byte_lengths,
            );
        }

        let hex_str = observed.into_iter().next().unwrap();
        let byte_length = hex_str.len() / 2;
        entries.push(CorpusEntry {
            name: r.name,
            fixture_path: r.fixture_path,
            prelude: r.prelude,
            source_es: r.es,
            tree_bytes_hex: hex_str,
            byte_length,
        });
    }

    Ok(CorpusFixture {
        corpus: "significant_15",
        entries,
        non_deterministic,
        compile_errors,
    })
}
