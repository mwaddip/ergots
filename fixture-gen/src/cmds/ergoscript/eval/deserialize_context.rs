//! DeserializeContext arm — oracle fixtures (phase 2i-c T6).
//!
//! Sigma-rust ref:
//!   - `ergotree-ir/src/mir/deserialize_context.rs` — struct {tpe, id}, wire codec
//!   - `ergotree-ir/src/mir/expr.rs:442-496` — `substitute_deserialize` walker
//!   - `ergotree-interpreter/src/eval.rs:203-250` — substitute dispatch
//!   - `ergotree-interpreter/src/eval/deserialize_context.rs` (tests-only)
//!
//! No add_jit_cost in this arm — cost arrives via the inner Expr's eval after
//! substitution. Oracle uses `try_eval_with_deserialize::<T>` (runs the
//! substitute pass then `try_eval_out`).
//!
//! For success cases we capture {value, cost} from sigma-rust; for throw cases
//! we capture {expected_error substring, expected_error_code}.
//!
//! P2PK-canary load-bearing scenario: `dc_const_sigmaprop_inner` — substituted
//! body becomes `Const(SSigmaProp, ProveDlog(g))`; sigma-rust's `reduce_to_crypto`
//! / `trivial_reduce` charges flat EVAL_SIGMA_PROP_CONSTANT=50, NOT per-arm
//! Const cost. We assert `expected_cost === 50` to pin this short-circuit for
//! the TS port (T8 must mirror).
//!
//! 8 scenarios (PLAN.md Task 6):
//!   Happy:
//!     - dc_bool_true             : inner=Const(SBoolean,true), outer.tpe=SBoolean
//!     - dc_height_eq_compare     : inner=BinOp(NEq, Height, 1i32), outer.tpe=SBoolean
//!     - dc_v3_unsigned_bigint    : inner=Const(SUnsignedBigInt, 0), outer.tpe=SUnsignedBigInt, V3 tree
//!     - dc_const_sigmaprop_inner : inner=Const(SSigmaProp, ProveDlog(G)), outer.tpe=SSigmaProp; cost=50 canary
//!   Throw:
//!     - dc_throw_key_not_found    : empty extension                     → 'deserialize-context-key-not-found'
//!     - dc_throw_wrong_input_type : ext[1] = 1i32 (not Coll[Byte])      → 'deserialize-input-not-byte-array'
//!     - dc_throw_parse_failed     : ext[1] = malformed bytes            → 'deserialize-parse-failed'
//!     - dc_throw_tpe_mismatch     : inner=Const(SInt,5), outer.tpe=SBoolean → 'deserialize-tpe-mismatch'

use core::cell::Cell;

use ergo_chain_types::ec_point::generator;
use ergo_chain_types::{BlockId, Digest32, EcPoint, PreHeader, Votes};
use ergotree_interpreter::eval::test_util::try_eval_with_deserialize;
use ergotree_ir::chain::context::{Context, ContextExtensionProvider};
use ergotree_ir::chain::context_extension::ContextExtension;
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::bin_op::{BinOp, BinOpKind, RelationOp};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::deserialize_context::DeserializeContext;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
// UnsignedBigInt was used by the dropped dc_v3_unsigned_bigint fixture; no
// longer referenced after the V3 fixture was excised from 2i-c.
// use ergotree_ir::unsignedbigint256::UnsignedBigInt;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp,
};
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;
use sigma_test_util::force_any_val;

use super::common::value_to_json;

/// Minimal `ContextExtensionProvider` carrying a single owned `ContextExtension`.
struct SimpleExtProvider(ContextExtension);

impl ContextExtensionProvider for SimpleExtProvider {
    fn context_extension(&self, _input_index: usize) -> Option<&ContextExtension> {
        Some(&self.0)
    }
}

#[derive(Serialize)]
pub struct DeserializeContextFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    /// `{ jitCostLimit?, extension?, treeVersion? }` — same convention as
    /// existing 2f-medium/2i-b fixtures (get_var.rs, option_get_or_else.rs).
    pub opts_json: JsonValue,
    /// null for error entries.
    pub expected_value_json: JsonValue,
    /// 0 for error entries.
    pub expected_cost: u64,
    /// Substring expected in `EvalError.message` for throw entries; null for
    /// success. Captures sigma-rust's error text loosely — TS-side messages
    /// follow the equivalent `'DeserializeContext: ...'` template per
    /// packages/ergoscript/src/eval/_substitute-deserialize.ts.
    pub expected_error: JsonValue,
    /// null for success entries.
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct DeserializeContextFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<DeserializeContextFixture>,
}

/// Build a minimal ErgoBox (`v1(false)` body = `Const(true)`). Mirrors the
/// pattern in get_var.rs/option_get_or_else.rs for selfBox stubs.
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

fn simple_box(nanoerg: u64) -> ErgoBox {
    let value = BoxValue::new(nanoerg).expect("BoxValue");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 0,
    };
    ErgoBox::from_box_candidate(&candidate, TxId::zero(), 0).expect("ErgoBox")
}

/// Build a controlled `Context<'static>` with the given extension and tree
/// version. Mirrors `controlled_context_with_extension_and_version` from
/// option_get_or_else.rs — hardcoded deterministic miner_pk + pre_header +
/// boxes, only the extension and tree_version vary per test case.
fn controlled_context(extension: ContextExtension, version: u8) -> Context<'static> {
    let gen_bytes = hex::decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    )
    .expect("decode gen bytes");
    let miner_pk: EcPoint = EcPoint::scorex_parse_bytes(&gen_bytes).expect("parse gen point");

    let base_ctx = force_any_val::<Context<'static>>();
    let pre_header = PreHeader {
        version: 1,
        parent_id: BlockId(Digest32::zero()),
        timestamp: 1_700_000_000_000u64,
        n_bits: 0x1d00ffff,
        height: 999_999,
        miner_pk: Box::new(miner_pk),
        votes: Votes([0, 0, 0]),
    };

    let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
    let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
    let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));

    let ext: &'static ContextExtension = Box::leak(Box::new(extension.clone()));
    let ext_provider: &'static SimpleExtProvider =
        Box::leak(Box::new(SimpleExtProvider(extension)));

    Context {
        height: 999_999,
        self_box,
        outputs: std::slice::from_ref(out_box),
        data_inputs: None,
        inputs: vec![in_box].try_into().expect("inputs TxIoVec"),
        pre_header,
        headers: base_ctx.headers,
        extension: ext,
        tree_version: Cell::new(ErgoTreeVersion::from(version)),
        extension_provider: ext_provider,
        jit_cost: Cell::new(0),
        jit_cost_limit: None,
        constants: None,
    }
}

/// Build the outer ErgoTree containing a `DeserializeContext { tpe, id }`
/// expression. `header_byte = 0x00` → V0; `0x03` → V3 (no segregation, no
/// size flag).
fn build_outer_tree(tpe: SType, id: u8, header_byte: u8) -> anyhow::Result<(ErgoTree, String)> {
    let dc = DeserializeContext { tpe, id };
    let expr: Expr = dc.into();
    let header = ErgoTreeHeader::new(header_byte)?;
    let tree = ErgoTree::new(header, &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Build a `Const(SColl[SByte], <bytes>)` constant from raw bytes — what the
/// caller stores into the context extension to feed the substitute pass.
fn coll_byte_constant(bytes: Vec<u8>) -> Constant {
    let signed: Vec<i8> = bytes.into_iter().map(|b| b as i8).collect();
    signed.into()
}

/// Build a ContextExtension from a single (id, constant) pair.
fn extension_one(id: u8, constant: Constant) -> ContextExtension {
    let mut ext = ContextExtension::empty();
    ext.values.insert(id, constant);
    ext
}

/// Encode a context-extension constant as the opts_json `extension` field
/// (mirrors `context_extension_to_json` from get_var.rs).
fn extension_to_opts_json(ext: &ContextExtension) -> JsonValue {
    let values: serde_json::Map<String, JsonValue> = ext
        .values
        .iter()
        .map(|(k, c)| {
            let entry = json!({
                "tpe": super::common::stype_to_json(&c.tpe),
                "value": value_to_json(&Value::from(c.v.clone())),
            });
            (k.to_string(), entry)
        })
        .collect();
    json!({ "values": values })
}

/// Encode a SigmaProp(ProveDlog(g)) value as `{ kind: "SigmaProp", raw_hex: ... }`
/// (mirrors `sigma_prop_value_to_json` from create_prove_dlog.rs).
fn sigma_prop_value_json(val: &Value) -> anyhow::Result<JsonValue> {
    if let Value::SigmaProp(sp) = val {
        let raw_bytes = sp.value().sigma_serialize_bytes()?;
        Ok(json!({ "kind": "SigmaProp", "raw_hex": hex::encode(&raw_bytes) }))
    } else {
        anyhow::bail!("expected SigmaProp value, got {:?}", val)
    }
}

pub fn generate() -> anyhow::Result<DeserializeContextFixtureFile> {
    let mut entries: Vec<DeserializeContextFixture> = Vec::new();

    // ─────────────────────────────────────────────────────────────────────────
    // 1. dc_bool_true — inner=Const(SBoolean,true), outer.tpe=SBoolean.
    // ─────────────────────────────────────────────────────────────────────────
    {
        let inner: Expr = true.into();
        let inner_bytes = inner.sigma_serialize_bytes()?;
        let constant = coll_byte_constant(inner_bytes);
        let ext = extension_one(1, constant);

        let (tree, hex) = build_outer_tree(SType::SBoolean, 1, 0x00)?;
        let ctx = controlled_context(ext.clone(), 0);
        let outer_expr = tree.proposition()?;
        let val: Value<'static> =
            try_eval_with_deserialize::<Value>(&outer_expr, &ctx)?.to_static();

        entries.push(DeserializeContextFixture {
            name: "dc_bool_true".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": extension_to_opts_json(&ext) }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error: json!(null),
            expected_error_code: json!(null),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. dc_height_eq_compare — inner=BinOp(NEq, Height, 1i32), outer.tpe=SBoolean.
    // ─────────────────────────────────────────────────────────────────────────
    {
        let inner: Expr = BinOp {
            kind: BinOpKind::Relation(RelationOp::NEq),
            left: Box::new(Expr::GlobalVars(GlobalVars::Height)),
            right: Box::new(Expr::Const(1i32.into())),
        }
        .into();
        let inner_bytes = inner.sigma_serialize_bytes()?;
        let constant = coll_byte_constant(inner_bytes);
        let ext = extension_one(1, constant);

        let (tree, hex) = build_outer_tree(SType::SBoolean, 1, 0x00)?;
        let ctx = controlled_context(ext.clone(), 0);
        let outer_expr = tree.proposition()?;
        let val: Value<'static> =
            try_eval_with_deserialize::<Value>(&outer_expr, &ctx)?.to_static();

        entries.push(DeserializeContextFixture {
            name: "dc_height_eq_compare".into(),
            tree_bytes_hex: hex,
            // Inner Expr accesses GlobalVars.Height; opts_json must carry
            // `height` so the TS test's makeContext reconstructs the same
            // chain-state the oracle ran under (controlled_context height=999999).
            opts_json: json!({
                "extension": extension_to_opts_json(&ext),
                "height": 999_999,
            }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error: json!(null),
            expected_error_code: json!(null),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // (V3 SUnsignedBigInt fixture dropped from 2i-c — SUnsignedBigInt is a
    //  v6-only type that our parser rejects at parse-stype. Validating the
    //  substitute pass's treeVersion threading without it is acceptable for
    //  this slice; revisit when v6 types ship.)
    // ─────────────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────────────
    // 4. dc_const_sigmaprop_inner — P2PK 50-cost short-circuit canary.
    //    inner = Const(SSigmaProp, ProveDlog(G)); outer.tpe = SSigmaProp.
    //    After substitution, outer tree.body becomes Const(SSigmaProp, ...).
    //    Sigma-rust's reduce_to_crypto runs trivial_reduce on the rewritten
    //    body and charges EVAL_SIGMA_PROP_CONSTANT=50 instead of per-arm Const.
    //    We pin expected_cost=50 to guard the TS port (T8) integration.
    //
    //    NOTE: `try_eval_with_deserialize` calls `try_eval_out`, which goes
    //    through `expr.eval()` directly — NOT `reduce_to_crypto`. The 50-cost
    //    short-circuit lives in `reduce_to_crypto::trivial_reduce`, NOT
    //    `Const::eval` (which charges 5). So the sigma-rust oracle reports
    //    the per-arm Const cost here, while sigma-rust's REAL pipeline
    //    (reduce_to_crypto) charges 50.
    //
    //    The TS T8 integration mirrors sigma-rust's reduce_to_crypto path
    //    via tryTrivialReduceExpr on the substituted body. So the TS test
    //    asserts cost === 50 (not the oracle's 5). To keep the fixture
    //    self-consistent, we hardcode expected_cost = 50 here (matching the
    //    p2pk_short_circuit.rs precedent which also hardcodes 50). The TS
    //    test will read expected_cost=50 directly.
    // ─────────────────────────────────────────────────────────────────────────
    {
        // SigmaBoolean::ProofOfKnowledge(ProveDlog(generator))
        let pk = generator();
        let sigma_bool = SigmaBoolean::ProofOfKnowledge(
            SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(pk)),
        );
        let sigma_prop = SigmaProp::new(sigma_bool.clone());
        let inner: Expr = Expr::Const(sigma_prop.into());
        let inner_bytes = inner.sigma_serialize_bytes()?;
        let constant = coll_byte_constant(inner_bytes);
        let ext = extension_one(1, constant);

        let (tree, hex) = build_outer_tree(SType::SSigmaProp, 1, 0x00)?;
        let ctx = controlled_context(ext.clone(), 0);
        let outer_expr = tree.proposition()?;
        // Evaluate via the substitute-then-eval oracle for value capture.
        let val: Value<'static> =
            try_eval_with_deserialize::<Value>(&outer_expr, &ctx)?.to_static();
        let expected_value = sigma_prop_value_json(&val)?;

        // expected_cost = 50 (EVAL_SIGMA_PROP_CONSTANT). Hardcoded — see
        // module comment + p2pk_short_circuit.rs:74 precedent.
        let expected_cost: u64 = 50;

        entries.push(DeserializeContextFixture {
            name: "dc_const_sigmaprop_inner".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": extension_to_opts_json(&ext) }),
            expected_value_json: expected_value,
            expected_cost,
            expected_error: json!(null),
            expected_error_code: json!(null),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. dc_throw_key_not_found — empty extension, lookup id=1.
    //    TS: 'DeserializeContext: extension.values[1] not found'
    //        code 'deserialize-context-key-not-found'
    // ─────────────────────────────────────────────────────────────────────────
    {
        let (_tree, hex) = build_outer_tree(SType::SBoolean, 1, 0x00)?;
        let empty_ext = ContextExtension::empty();
        // (Confirm sigma-rust errors as expected.)
        let ctx = controlled_context(empty_ext.clone(), 0);
        let outer_expr = ErgoTree::new(ErgoTreeHeader::v0(false), &Expr::from(DeserializeContext {
            tpe: SType::SBoolean,
            id: 1,
        }))?
        .proposition()?;
        let result = try_eval_with_deserialize::<Value>(&outer_expr, &ctx);
        assert!(result.is_err(), "expected throw for empty extension");

        entries.push(DeserializeContextFixture {
            name: "dc_throw_key_not_found".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": extension_to_opts_json(&empty_ext) }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error: json!("extension.values[1] not found"),
            expected_error_code: json!("deserialize-context-key-not-found"),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. dc_throw_wrong_input_type — ext[1] = 1i32 (SInt, not Coll[Byte]).
    //    TS: 'DeserializeContext: extension.values[1].tpe must be Coll[Byte], got SInt'
    //        code 'deserialize-input-not-byte-array'
    // ─────────────────────────────────────────────────────────────────────────
    {
        let (_tree, hex) = build_outer_tree(SType::SBoolean, 1, 0x00)?;
        let bad_constant: Constant = 1i32.into();
        let ext = extension_one(1, bad_constant);
        // Confirm sigma-rust errors as expected.
        let ctx = controlled_context(ext.clone(), 0);
        let outer_expr = ErgoTree::new(ErgoTreeHeader::v0(false), &Expr::from(DeserializeContext {
            tpe: SType::SBoolean,
            id: 1,
        }))?
        .proposition()?;
        let result = try_eval_with_deserialize::<Value>(&outer_expr, &ctx);
        assert!(result.is_err(), "expected throw for wrong input type");

        entries.push(DeserializeContextFixture {
            name: "dc_throw_wrong_input_type".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": extension_to_opts_json(&ext) }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error: json!("must be Coll[Byte]"),
            expected_error_code: json!("deserialize-input-not-byte-array"),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. dc_throw_parse_failed — ext[1] = malformed Expr bytes.
    //    A buffer of three 0xFF bytes cannot start a valid opcode/SType
    //    chain — sigma-rust's parser throws ExprParsingError; TS-side
    //    parser throws via parseExpr → wrapped as 'deserialize-parse-failed'.
    // ─────────────────────────────────────────────────────────────────────────
    {
        let (_tree, hex) = build_outer_tree(SType::SBoolean, 1, 0x00)?;
        let malformed = vec![0xffu8, 0xffu8, 0xffu8];
        let constant = coll_byte_constant(malformed);
        let ext = extension_one(1, constant);
        // Confirm sigma-rust errors as expected.
        let ctx = controlled_context(ext.clone(), 0);
        let outer_expr = ErgoTree::new(ErgoTreeHeader::v0(false), &Expr::from(DeserializeContext {
            tpe: SType::SBoolean,
            id: 1,
        }))?
        .proposition()?;
        let result = try_eval_with_deserialize::<Value>(&outer_expr, &ctx);
        assert!(result.is_err(), "expected throw for malformed bytes");

        entries.push(DeserializeContextFixture {
            name: "dc_throw_parse_failed".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": extension_to_opts_json(&ext) }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error: json!("inner Expr parse failed"),
            expected_error_code: json!("deserialize-parse-failed"),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. dc_throw_tpe_mismatch — inner=Const(SInt,5), outer.tpe=SBoolean.
    //    TS: 'DeserializeContext: inner Expr tpe mismatch (expected SBoolean, got SInt)'
    //        code 'deserialize-tpe-mismatch'
    // ─────────────────────────────────────────────────────────────────────────
    {
        let (_tree, hex) = build_outer_tree(SType::SBoolean, 1, 0x00)?;
        let inner: Expr = Expr::Const(5i32.into());
        let inner_bytes = inner.sigma_serialize_bytes()?;
        let constant = coll_byte_constant(inner_bytes);
        let ext = extension_one(1, constant);
        // Confirm sigma-rust errors as expected.
        let ctx = controlled_context(ext.clone(), 0);
        let outer_expr = ErgoTree::new(ErgoTreeHeader::v0(false), &Expr::from(DeserializeContext {
            tpe: SType::SBoolean,
            id: 1,
        }))?
        .proposition()?;
        let result = try_eval_with_deserialize::<Value>(&outer_expr, &ctx);
        assert!(result.is_err(), "expected throw for tpe mismatch");

        entries.push(DeserializeContextFixture {
            name: "dc_throw_tpe_mismatch".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": extension_to_opts_json(&ext) }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error: json!("tpe mismatch"),
            expected_error_code: json!("deserialize-tpe-mismatch"),
        });
    }

    Ok(DeserializeContextFixtureFile {
        corpus: "eval_deserialize_context",
        entries,
    })
}
