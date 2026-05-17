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

use core::cell::Cell;

use ergo_chain_types::{BlockId, Digest32, EcPoint, PreHeader, Votes};
use ergotree_interpreter::eval::EvalError;
use ergotree_ir::chain::context::{Context, ContextExtensionProvider};
use ergotree_ir::chain::context_extension::ContextExtension;
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::token::{Token, TokenAmount, TokenId};
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use serde::{Deserialize, Serialize};
use sigma_ser::ScorexSerializable;

// ---------------------------------------------------------------------------
// Controlled-context helpers for reproducible corpus eval.
//
// The corpus was previously evaluated using `TestRunner::deterministic()` +
// `<Context as Arbitrary>::arbitrary()`. That random context is hard to
// reproduce in TS — the random box data affects per-item costs and branch
// outcomes. We switch to a hand-crafted, minimal-but-sufficient context
// that TS's `makeContext({...synthesizeStubBox...})` can reproduce exactly.
//
// Context shape (must mirror `corpus-eval.test.ts`):
//   inputs:       [box_with_1_token, box_with_1_token]
//   outputs:      [box_with_2_tokens, box_with_0_tokens]
//   data_inputs:  Some([box_with_0_tokens])
//   self_box:     inputs[0]
//   height:       0
//
// This shape was chosen to:
//   a) provide ≥2 inputs + outputs (all corpus trees that use ByIndex pass)
//   b) mirror the TS `synthesizeStubBox` shape (value=1_000_000, minimal ergoTree,
//      all-zero txId, creationHeight=0)
// ---------------------------------------------------------------------------

/// Minimal ContextExtensionProvider (single empty extension for all inputs).
struct SimpleExtProvider(ContextExtension);

impl ContextExtensionProvider for SimpleExtProvider {
    fn context_extension(&self, _input_index: usize) -> Option<&ContextExtension> {
        Some(&self.0)
    }
}

/// Build a minimal ErgoTree matching TS's `synthesizeStubBox.ergoTreeBytes`.
/// TS uses `09020101` = ErgoTreeHeader::v1(false) + Const(SBoolean, true).
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build an ErgoBox matching TS's `synthesizeStubBox`:
///   value = 1_000_000, ergoTree = minimal, creationHeight = 0,
///   txId = all-zeros, index = 0.
/// `tokens` is the token list (may be empty).
fn stub_box(tokens: Vec<Token>) -> ErgoBox {
    let value = BoxValue::new(1_000_000).expect("BoxValue");
    let tokens_opt = if tokens.is_empty() {
        None
    } else {
        Some(
            ergotree_ir::chain::ergo_box::BoxTokens::from_vec(tokens).expect("BoxTokens"),
        )
    };
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: tokens_opt,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 0,
    };
    ErgoBox::from_box_candidate(&candidate, TxId::zero(), 0).expect("ErgoBox")
}

/// Build a deterministic Token with all-zero token id and given amount.
/// Matches TS's `synthesizeStubBox({ tokens: [{ id: new Uint8Array(32), amount: 1n }] })`.
fn stub_token() -> Token {
    let id_hex = hex::encode([0u8; 32]);
    let token_id = TokenId::from(Digest32::try_from(id_hex).expect("Digest32"));
    let token_amount = TokenAmount::try_from(1u64).expect("TokenAmount");
    Token {
        token_id,
        amount: token_amount,
    }
}

/// Construct the controlled corpus context — reproducible in TS.
///
/// Shape matches the stub in `corpus-eval.test.ts`:
///   inputs:      [box(1 token), box(1 token)]  (self_box = inputs[0])
///   outputs:     [box(2 tokens), box(0 tokens)]
///   data_inputs: Some([box(0 tokens)])
///   height:      0
///   pre_header:  minimal (height=1, miner_pk = secp256k1 generator)
///
/// `headers` is the only field that requires a non-trivial arbitrary value.
/// We use `TestRunner::deterministic()` (fixed proptest seed) for the header
/// array so it's deterministic across `cargo run` invocations. The corpus
/// trees in the 18-evaluable set don't inspect individual header fields, so
/// the specific header contents don't affect eval outcomes or costs.
fn corpus_context() -> Context<'static> {
    use ergo_chain_types::Header;
    use proptest::prelude::Arbitrary;
    use proptest::strategy::{Strategy, ValueTree};
    use proptest::test_runner::TestRunner;

    let gen_bytes = hex::decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    )
    .expect("decode gen bytes");
    let miner_pk: EcPoint = EcPoint::scorex_parse_bytes(&gen_bytes).expect("parse gen point");

    let pre_header = PreHeader {
        version: 1,
        parent_id: BlockId(Digest32::zero()),
        timestamp: 1_700_000_000_000u64,
        n_bits: 0x1d00ffff,
        height: 1,
        miner_pk: Box::new(miner_pk),
        votes: Votes([0, 0, 0]),
    };

    // Deterministic headers via fixed proptest seed — content doesn't affect
    // eval outcomes for the 18 evaluable corpus trees.
    let mut runner = TestRunner::deterministic();
    let headers: [Header; 10] = <[Header; 10] as Arbitrary>::arbitrary()
        .new_tree(&mut runner)
        .expect("Header arbitrary")
        .current();

    let box1t: &'static ErgoBox = Box::leak(Box::new(stub_box(vec![stub_token()])));
    let box0t: &'static ErgoBox = Box::leak(Box::new(stub_box(vec![])));

    let ext: &'static ContextExtension = Box::leak(Box::new(ContextExtension::empty()));
    let ext_provider: &'static SimpleExtProvider =
        Box::leak(Box::new(SimpleExtProvider(ContextExtension::empty())));

    let data_inputs = {
        let v: Vec<&'static ErgoBox> = vec![box0t];
        let bv: ergotree_ir::chain::context::TxIoVec<&'static ErgoBox> =
            v.try_into().expect("data_inputs TxIoVec");
        Some(bv)
    };

    // outputs: [box(2 tokens), box(0 tokens)]
    let outputs_vec: Vec<ErgoBox> = vec![
        stub_box(vec![stub_token(), stub_token()]),
        stub_box(vec![]),
    ];
    let outputs_slice: &'static [ErgoBox] = Vec::leak(outputs_vec);

    Context {
        height: 0,
        self_box: box1t,
        inputs: vec![box1t, box1t].try_into().expect("inputs TxIoVec"),
        outputs: outputs_slice,
        data_inputs,
        pre_header,
        headers,
        extension: ext,
        tree_version: Cell::new(ErgoTreeVersion::V0),
        extension_provider: ext_provider,
        jit_cost: Cell::new(0),
        jit_cost_limit: None,
        constants: None,
    }
}

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

        // Layer C2: capture sigma-rust eval against a controlled synthetic Context.
        // Uses test_util (gated by 'arbitrary' feature on ergotree-interpreter).
        // Skip when round-trip already failed — the bytes weren't well-formed,
        // so eval has nothing to chew on.
        let sigma_rust_eval = if round_trip_ok {
            use ergotree_interpreter::eval::test_util::try_eval_out;
            use ergotree_ir::mir::value::Value;

            // Controlled Context: uses corpus_context() which is reproducible
            // in TS via makeContext({ selfBox: stubBox, inputs: [...], ... }).
            // Previously used TestRunner::deterministic() + proptest arbitrary,
            // but the random box data affected per-item costs and branch outcomes
            // in ways the TS test couldn't reproduce.
            //
            // Each tree resets jit_cost to 0 so jit_cost_value() measures only
            // that tree's cost.
            let ctx = corpus_context();
            match ErgoTree::sigma_parse_bytes(&bytes) {
                Ok(tree) => match (tree.root_expr(), tree.constants()) {
                    (Ok(root), Ok(constants)) => {
                        // Use root_expr() + with_constants() (lazy ConstantPlaceholder
                        // resolution, cost 1 per placeholder) rather than proposition()
                        // (which substitutes placeholders to Const nodes, cost 5 each).
                        // This matches the TS evaluator's path — evaluateWith() passes
                        // tree.constants as ctx.constants and resolves on demand.
                        let ctx_with_c = ctx.with_constants(constants);
                        match try_eval_out::<Value<'static>>(root, &ctx_with_c) {
                            Ok(val) => Some(SigmaRustEval::SyntheticEmpty {
                                ok: true,
                                value_json: Some(super::eval::common::value_to_json(&val)),
                                // Use ctx_with_c (not ctx) — with_constants clones the
                                // jit_cost Cell, so cost accumulates on the inner context.
                                jit_cost: Some(ctx_with_c.jit_cost_value()),
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
                        }
                    }
                    (Err(e), _) | (_, Err(e)) => Some(SigmaRustEval::SyntheticEmpty {
                        ok: false,
                        value_json: None,
                        jit_cost: None,
                        error_kind: Some(format!("root_expr/constants: {:?}", e)),
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
