//! Legacy 45-contract corpus.
//!
//! Sourced from PR 862's compiler test inventory in
//! `sigma-rust/ergoscript-compiler/src/compiler.rs`:
//!   - 15 contracts from `test_batch_node_byte_match` (each carries its known
//!     reference node hex so we can detect drift)
//!   - 6 contracts from `test_real_world_contracts`
//!   - 16 contracts from `test_p2p_*`
//!   - 3 contracts from `test_ecosystem_phoenix_hodlerg_bank` /
//!     `test_ecosystem_off_the_grid` / `test_ecosystem_crystal_pool_buy`
//!   - 5 misc contracts (oracle, vault, reserve, time validator, BigInt if/else)
//!
//! Total: 45 entries — the "legacy 45/46" coverage minus the deeply nested
//! BigInt polynomial that crashes CSE (DuckPools ERG InterestRate).
//!
//! The source corpus is checked in as JSON under
//! `fixture-gen/data/ergoscript/legacy_45.json` and embedded at build time
//! via `include_str!`. The fixture generator compiles each entry via
//! `ergoscript_compiler::compile` and emits the resulting ErgoTree bytes
//! alongside the source text. Entries that came from
//! `test_batch_node_byte_match` also include `node_hex_check` — a hex string
//! the local compile output must match exactly. If it doesn't, the
//! determinism check fails and we know something drifted in the upstream
//! compiler or our parsing surface.
//!
//! ## Known-unstable filter
//!
//! See [`KNOWN_UNSTABLE`]. A handful of entries trigger an upstream
//! `ergoscript-compiler` bug in `transform_fold_lambda` +
//! `sequential_renumber`: sigma-rust's own parser rejects the bytes it
//! just emitted (`SigmaParsingError::ValDefIdNotFound`). Those entries
//! never reach `entries` — they're recorded in `non_deterministic` with
//! `known_unstable: true` so the bug surface stays visible without
//! gating fixture-gen on an upstream fix.

use ergoscript_compiler::compiler::compile;
use ergoscript_compiler::script_env::ScriptEnv;
use ergotree_ir::serialization::SigmaSerializable;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Number of times we compile each source to verify byte-stable output.
/// The upstream compiler's CSE pass uses `std::collections::HashMap`
/// (RandomState), which can produce different ErgoTree bytes across runs
/// for some contracts. Empirically all 45 legacy entries are deterministic,
/// but we keep the same filter mechanism as `corpus_ecosystem_14` /
/// `corpus_significant_15` so a future drift is caught early instead of
/// landing as a fixture diff in CI.
const STABILITY_PASSES: usize = 3;

/// Contracts that trigger an upstream `ergoscript-compiler` bug in
/// `transform_fold_lambda` + `sequential_renumber`: the rewrite produces
/// `ValUse` references that sigma-rust's own parser cannot re-resolve
/// (`SigmaParsingError::ValDefIdNotFound(ValId(3))`). Mark as unstable
/// rather than skip compilation entirely so the bug surface is visible.
///
/// Unlike the CSE-randomization KNOWN_UNSTABLE list in
/// `corpus_ecosystem_14` / `corpus_significant_15`, these entries compile
/// deterministically — they're just unusable for round-trip testing
/// because the bytes sigma-rust emits cannot be parsed by sigma-rust
/// itself, let alone by our TS parser.
const KNOWN_UNSTABLE: &[&str] = &[
    "test_p2p_option_reserve_v2_core_logic",
    "test_p2p_option_reserve_v2_full",
    "test_p2p_option_reserve_v2_nested_fold",
    "test_session8_time_validator_contract",
];

/// Raw corpus entry as stored in `data/ergoscript/legacy_45.json`.
#[derive(Deserialize)]
struct RawEntry {
    name: String,
    source: String,
    es: String,
    #[serde(default)]
    node_hex: Option<String>,
}

/// Output corpus entry written to `packages/ergoscript/test/fixtures/`.
#[derive(Serialize)]
pub struct CorpusEntry {
    pub name: String,
    /// Where the entry came from inside the compiler test suite. One of:
    /// `batch_node_byte_match`, `real_world_contracts`, `p2p_test`,
    /// `ecosystem_test`, `misc_test`.
    pub origin: String,
    /// The raw ErgoScript source we feed to `ergoscript_compiler::compile`.
    pub source_es: String,
    /// Compiled ErgoTree bytes, lowercase hex.
    pub tree_bytes_hex: String,
    /// Length of the compiled ErgoTree bytes.
    pub byte_length: usize,
    /// Present iff this entry came from `test_batch_node_byte_match`. When
    /// set, our compiled bytes must equal this hex string exactly; otherwise
    /// the determinism-vs-Scala-node invariant is broken.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_hex_check: Option<String>,
}

#[derive(Serialize)]
pub struct NonDeterministicEntry {
    pub name: String,
    pub origin: String,
    pub source_es: String,
    /// `true` when this entry is on the static [`KNOWN_UNSTABLE`] list and
    /// was deliberately not compiled.
    pub known_unstable: bool,
}

#[derive(Serialize)]
pub struct CorpusFixture {
    pub corpus: &'static str,
    pub entries: Vec<CorpusEntry>,
    /// Entries deliberately skipped because their `name` is in
    /// [`KNOWN_UNSTABLE`]. See the constant doc-comment for the upstream
    /// bug surface they exercise.
    pub non_deterministic: Vec<NonDeterministicEntry>,
    /// Number of entries where the compiled bytes matched `node_hex_check`.
    /// Always equal to the count of entries carrying a `node_hex_check`.
    pub byte_match_count: usize,
    /// Compile errors encountered. Empty list means clean run.
    pub compile_errors: Vec<String>,
}

const CORPUS_JSON: &str = include_str!("../../../data/ergoscript/legacy_45.json");

pub fn generate() -> anyhow::Result<CorpusFixture> {
    let raw: Vec<RawEntry> = serde_json::from_str(CORPUS_JSON)?;
    let mut entries = Vec::with_capacity(raw.len());
    let mut non_deterministic: Vec<NonDeterministicEntry> = Vec::new();
    let mut compile_errors = Vec::new();
    let mut byte_match_count = 0usize;

    for r in raw {
        if KNOWN_UNSTABLE.contains(&r.name.as_str()) {
            non_deterministic.push(NonDeterministicEntry {
                name: r.name,
                origin: r.source,
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
            // The remaining legacy entries (those not on KNOWN_UNSTABLE)
            // are empirically deterministic. If any drift slips in, fail
            // loudly so the situation is noticed and either the upstream
            // compiler is fixed or the unstable entry is added to
            // `KNOWN_UNSTABLE` (mirroring `corpus_ecosystem_14` /
            // `corpus_significant_15`).
            let observed_hex: Vec<String> = observed.into_iter().collect();
            let observed_byte_lengths: Vec<usize> =
                observed_hex.iter().map(|h| h.len() / 2).collect();
            anyhow::bail!(
                "legacy_45: contract {:?} produced {} distinct ErgoTree byte outputs \
                 over {} compile passes (sizes={:?}). Add it to KNOWN_UNSTABLE in \
                 fixture-gen/src/cmds/ergoscript/corpus_legacy_45.rs and re-run.",
                r.name,
                observed_hex.len(),
                STABILITY_PASSES,
                observed_byte_lengths,
            );
        }

        let tree_hex = observed.into_iter().next().unwrap();
        let byte_length = tree_hex.len() / 2;

        if let Some(ref expected) = r.node_hex {
            if &tree_hex != expected {
                anyhow::bail!(
                    "byte-match drift on {}: local {} bytes vs expected {} bytes ({}...)\n  local: {}\n  ref:   {}",
                    r.name,
                    byte_length,
                    expected.len() / 2,
                    &tree_hex[..tree_hex.len().min(64)],
                    tree_hex,
                    expected
                );
            }
            byte_match_count += 1;
        }

        entries.push(CorpusEntry {
            name: r.name,
            origin: r.source,
            source_es: r.es,
            tree_bytes_hex: tree_hex,
            byte_length,
            node_hex_check: r.node_hex,
        });
    }

    Ok(CorpusFixture {
        corpus: "legacy_45",
        entries,
        non_deterministic,
        byte_match_count,
        compile_errors,
    })
}
