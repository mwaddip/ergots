//! Mainnet box ErgoTree corpus.
//!
//! **Status: deferred.** This module is wired into the generator pipeline
//! so that adding box data later is purely a JSON drop-in, but for now no
//! pre-cached mainnet boxes are bundled. We need a JSON file at
//! `fixture-gen/data/ergoscript/mainnet_boxes.json` shaped like:
//!
//! ```json
//! [
//!   {
//!     "box_id": "...",
//!     "ergo_tree_hex": "...",
//!     "block_height": 1234567
//!   },
//!   ...
//! ]
//! ```
//!
//! When that file appears, this generator parses each `ergo_tree_hex` via
//! `ErgoTree::sigma_parse_bytes` to confirm it's well-formed and emits a
//! fixture entry. We avoid the live HTTP fetch on purpose: `cargo run`
//! must be deterministic in CI, and that means no `localhost:9052` calls.
//!
//! See task 29's report for the rationale on why this is the only piece
//! of task 29 deferred — the 45 + 14 + 15 = 74 contract fixtures from
//! `corpus_legacy_45`, `corpus_ecosystem_14`, and `corpus_significant_15`
//! are the load-bearing parity surface.

use ergotree_interpreter::eval::EvalError;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::serialization::SigmaSerializable;
use serde::{Deserialize, Serialize};

/// Extract a stable, hash-randomization-free kind code from an EvalError.
///
/// `format!("{:?}", e)` is **non-deterministic** because EvalError::Spanned
/// embeds an `Env { store: HashMap<ValId, Value> }`, and Rust's HashMap
/// iteration order is randomized via SipHash with a per-process seed
/// (`std::collections::hash_map::RandomState`). That order leaks into Debug
/// output → fixture diffs every fixture-gen run.
///
/// We sidestep that by returning a structured kind string of the form
/// `<OuterVariant>` or `<OuterVariant>:<InnerVariant>` (when wrapped in
/// Spanned/SpannedWithSource), with a small bounded payload from variants
/// that already carry stable strings (the `String` payload of
/// UnexpectedValue, Misc, etc. comes from the evaluator code itself, not
/// from runtime state).
fn eval_error_kind(e: &EvalError) -> String {
    use EvalError::*;
    match e {
        AvlTree(s) => format!("AvlTree: {}", s),
        InvalidResultType => "InvalidResultType".to_string(),
        UnexpectedExpr(s) => format!("UnexpectedExpr: {}", s),
        CostError(c) => format!("CostError: {:?}", c),
        TryExtractFrom(t) => format!("TryExtractFrom: {:?}", t),
        NotFound(s) => format!("NotFound: {}", s),
        RegisterIdOutOfBounds(s) => format!("RegisterIdOutOfBounds: {}", s),
        UnexpectedValue(s) => format!("UnexpectedValue: {}", s),
        ArithmeticException(s) => format!("ArithmeticException: {}", s),
        Misc(s) => format!("Misc: {}", s),
        SigmaSerializationError(_) => "SigmaSerializationError".to_string(),
        SigmaParsingError(_) => "SigmaParsingError".to_string(),
        ErgoTreeError(_) => "ErgoTreeError".to_string(),
        BoundedVecError(_) => "BoundedVecError".to_string(),
        ScorexSerializationError(_) => "ScorexSerializationError".to_string(),
        ScorexParsingError(_) => "ScorexParsingError".to_string(),
        // Unwrap Spanned wrappers — their Env { store: HashMap } debug repr
        // is hash-randomized. Recurse into the inner error to get a stable code.
        Spanned(inner) => format!("Spanned:{}", eval_error_kind(&inner.error)),
        SpannedWithSource(_) => "SpannedWithSource".to_string(),
        ScriptVersionError {
            required_version,
            activated_version,
        } => format!(
            "ScriptVersionError: required={:?} activated={:?}",
            required_version, activated_version
        ),
        SubstDeserializeError(_) => "SubstDeserializeError".to_string(),
        AutolykosPowSchemeError(_) => "AutolykosPowSchemeError".to_string(),
    }
}

#[derive(Deserialize)]
struct RawEntry {
    box_id: String,
    ergo_tree_hex: String,
    #[serde(default)]
    block_height: Option<i64>,
}

/// Layer C2: per-tree sigma-rust eval capture. Tagged on `context_kind` so
/// future variants (e.g. `RealOnChain { tx_hash, ... }` once we wire C3)
/// slot in additively. The TS side dispatches on `context_kind` and ignores
/// unknown tags so adding variants is non-breaking.
#[derive(Serialize)]
#[serde(tag = "context_kind", rename_all = "kebab-case")]
pub enum SigmaRustEval {
    SyntheticEmpty {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value_json: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        jit_cost: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_kind: Option<String>,
    },
    // RealOnChain variant added in C3 (phase 2j or earlier).
}

#[derive(Serialize)]
pub struct CorpusEntry {
    pub box_id: String,
    pub ergo_tree_hex: String,
    pub byte_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_height: Option<i64>,
    /// `true` once the bytes survive a parse + re-serialize cycle (so we
    /// know they're well-formed before TS tests touch them).
    pub round_trip_ok: bool,
    /// Layer C2: sigma-rust eval against a synthetic empty Context. `None`
    /// when round-trip already failed (we never tried to eval). Always
    /// `Some(SyntheticEmpty { .. })` otherwise; `ok` distinguishes success
    /// from failure inside.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sigma_rust_eval: Option<SigmaRustEval>,
}

#[derive(Serialize)]
pub struct CorpusFixture {
    pub corpus: &'static str,
    /// `true` when no `mainnet_boxes.json` data file is present. Lets the TS
    /// harness skip the suite cleanly instead of erroring on an empty entry
    /// list.
    pub deferred: bool,
    pub entries: Vec<CorpusEntry>,
    pub parse_errors: Vec<String>,
}

pub fn generate() -> anyhow::Result<CorpusFixture> {
    let data_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("data")
        .join("ergoscript")
        .join("mainnet_boxes.json");

    if !data_path.exists() {
        return Ok(CorpusFixture {
            corpus: "mainnet_boxes",
            deferred: true,
            entries: Vec::new(),
            parse_errors: Vec::new(),
        });
    }

    let json = std::fs::read_to_string(&data_path)?;
    let raw: Vec<RawEntry> = serde_json::from_str(&json)?;
    let mut entries = Vec::with_capacity(raw.len());
    let mut parse_errors = Vec::new();

    for r in raw {
        let bytes = match hex::decode(&r.ergo_tree_hex) {
            Ok(b) => b,
            Err(e) => {
                parse_errors.push(format!("{}: hex decode failed: {}", r.box_id, e));
                continue;
            }
        };
        let round_trip_ok = match ErgoTree::sigma_parse_bytes(&bytes) {
            Ok(tree) => match tree.sigma_serialize_bytes() {
                Ok(serialized) => serialized == bytes,
                Err(e) => {
                    parse_errors.push(format!("{}: re-serialize failed: {:?}", r.box_id, e));
                    false
                }
            },
            Err(e) => {
                parse_errors.push(format!("{}: parse failed: {:?}", r.box_id, e));
                false
            }
        };

        // Layer C2: capture sigma-rust eval against a synthetic Context.
        // Uses test_util (gated by 'arbitrary' feature on ergotree-interpreter).
        // Skip when round-trip already failed — the bytes weren't well-formed,
        // so eval has nothing to chew on.
        let sigma_rust_eval = if round_trip_ok {
            use ergotree_interpreter::eval::test_util::try_eval_out;
            use ergotree_ir::chain::context::Context;
            use ergotree_ir::mir::value::Value;
            use proptest::prelude::Arbitrary;
            use proptest::strategy::{Strategy, ValueTree};
            use proptest::test_runner::TestRunner;

            // Deterministic Context: mainnet trees deeply inspect ctx fields
            // (registers, inputs, height, etc), so a random Context propagates
            // into success/failure outcomes AND into error_kind strings (which
            // include env state). `force_any_val` uses `TestRunner::default()`
            // which seeds from the OS RNG → fixture diffs every run. We use
            // `TestRunner::deterministic()` (fixed seed) instead so the
            // mainnet_boxes corpus is byte-stable across regenerations,
            // satisfying CLAUDE.md's determinism contract for `cargo run`.
            //
            // Each tree gets a *fresh* deterministic ctx so jit_cost_value()
            // measures only that tree's cost, not the cumulative cost across
            // the corpus.
            let mut runner = TestRunner::deterministic();
            let ctx: Context<'static> =
                <Context as Arbitrary>::arbitrary()
                    .new_tree(&mut runner)
                    .map_err(|e| anyhow::anyhow!("Context proptest tree: {}", e))?
                    .current();
            match ErgoTree::sigma_parse_bytes(&bytes) {
                Ok(tree) => match tree.proposition() {
                    Ok(expr) => match try_eval_out::<Value<'static>>(&expr, &ctx) {
                        Ok(val) => Some(SigmaRustEval::SyntheticEmpty {
                            ok: true,
                            value_json: Some(super::eval::common::value_to_json(&val)),
                            jit_cost: Some(ctx.jit_cost_value()),
                            error_kind: None,
                        }),
                        // Use eval_error_kind, NOT format!("{:?}", e), to avoid
                        // hash-randomized HashMap iteration order leaking into
                        // the Spanned variant's Env { store: HashMap } debug.
                        Err(e) => Some(SigmaRustEval::SyntheticEmpty {
                            ok: false,
                            value_json: None,
                            jit_cost: None,
                            error_kind: Some(eval_error_kind(&e)),
                        }),
                    },
                    Err(e) => Some(SigmaRustEval::SyntheticEmpty {
                        ok: false,
                        value_json: None,
                        jit_cost: None,
                        error_kind: Some(format!("proposition: {:?}", e)),
                    }),
                },
                Err(_) => None, // already failed round-trip — defensive, shouldn't reach here
            }
        } else {
            None
        };

        entries.push(CorpusEntry {
            box_id: r.box_id,
            byte_length: bytes.len(),
            ergo_tree_hex: r.ergo_tree_hex,
            block_height: r.block_height,
            round_trip_ok,
            sigma_rust_eval,
        });
    }

    Ok(CorpusFixture {
        corpus: "mainnet_boxes",
        deferred: false,
        entries,
        parse_errors,
    })
}
