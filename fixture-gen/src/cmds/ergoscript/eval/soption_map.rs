//! SOption.map handler — fixtures (campaign iter-29).
//!
//! `Option[T].map(f: T => R): Option[R]` — lambda HOF.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/soption.rs:13-60` (`map_eval`).
//! Method registration: `ergotree-ir/src/types/soption.rs::MAP_METHOD`
//!   (MAP_METHOD_ID = 7; `min_version: V0` — NO version gate).
//!
//! Cost: `ctx.add_jit_cost(20)` — Fixed(20), Pattern A (charged FIRST).
//! Semantics: `Some(t)` → `Some(lambda(t))`; `None` → `None`. Lambda invocation
//! mirrors flatMap's env-extend (scoll.rs:85-98). No body restriction (unlike flatMap).
//!
//! **Receiver:** an Option *Constant* cannot be sigma-serialized ("Option
//! serialization is not supported" — Options have no wire literal; they arise from
//! operations). So the map receiver is `ExtractRegisterAs(box, R4, Option[T])` —
//! Some when R4 is present, None when absent — exactly how Options appear on-chain
//! (`SELF.R4[T].map(...)`). The TS side already evals ExtractRegisterAs, so the
//! fixture still isolates map's value+cost contribution. (The walker itself only
//! checks cost, so the real-tx Option source is irrelevant there.)
//!
//! `value_to_json` (common.rs) has no `Value::Opt` arm (runtime erases the elem
//! SType), so — like `extract_register_as.rs` — the expected Option JSON is built
//! directly via `option_json` using the KNOWN output type R (= method `ov`). The
//! TS handler derives the same elem from `exprTpe(closure.body)`; fixtures use
//! BinOp bodies whose exprTpe resolves concretely, so elem matches byte-for-byte.
//!
//! Entries (5): Some/None × type-change (Long→Bool via Gt, mirrors sigma-rust
//! `eval_map_some`/`eval_map_none`) and type-preserving (Long→Long, Int→Int via Plus).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, RelationOp};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_reg_as::ExtractRegisterAs;
use ergotree_ir::mir::func_value::{FuncArg, FuncValue};
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::soption::MAP_METHOD;
use ergotree_ir::types::stype::SType;
use ergotree_ir::types::stype_param::STypeVar;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::{stype_to_json, value_to_json, EvalFixture, EvalFixtureFile};

/// Minimal v1 (hasSize) ErgoTree for the box guarding script — the TS SBox parser
/// demands hasSize=true. Mirrors `extract_register_as.rs::minimal_ergo_tree`.
fn minimal_ergo_tree() -> ErgoTree {
    ErgoTree::new(ErgoTreeHeader::v1(false), &Expr::Const(true.into())).expect("minimal ErgoTree")
}

/// Box carrying register R4 = `r4`.
fn box_with_r4(r4: Constant) -> ErgoBox {
    let candidate = ErgoBoxCandidate {
        value: BoxValue::new(1_000_000).expect("BoxValue"),
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: NonMandatoryRegisters::try_from(vec![r4]).expect("registers"),
        creation_height: 100,
    };
    ErgoBox::from_box_candidate(&candidate, TxId::zero(), 1).expect("ErgoBox")
}

/// Box with no additional registers (R4 absent → ExtractRegisterAs returns None).
fn box_no_registers() -> ErgoBox {
    let candidate = ErgoBoxCandidate {
        value: BoxValue::new(1_000_000).expect("BoxValue"),
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 42,
    };
    ErgoBox::from_box_candidate(&candidate, TxId::zero(), 0).expect("ErgoBox")
}

/// Build the Option JSON for `expected_value_json` (mirrors
/// `extract_register_as.rs::option_json`). Schema: `{ kind, elem, value }`.
fn option_json(elem_tpe: &SType, inner: Option<JsonValue>) -> JsonValue {
    json!({
        "kind": "Option",
        "elem": stype_to_json(elem_tpe),
        "value": inner.unwrap_or(JsonValue::Null),
    })
}

/// Build a `ExtractRegisterAs(box, R4, Option[iv]).map(f)` fixture.
fn entry(
    name: &str,
    ergo_box: ErgoBox,
    iv: SType,
    ov: SType,
    body: Expr,
) -> anyhow::Result<EvalFixture> {
    let obj: Expr = ExtractRegisterAs::new(
        Expr::Const(ergo_box.into()),
        4,
        SType::SOption(iv.clone().into()),
    )
    .map_err(|e| anyhow::anyhow!("ExtractRegisterAs::new: {0:?}", e))?
    .into();
    let type_args = [
        (STypeVar::iv(), iv.clone()),
        (STypeVar::ov(), ov.clone()),
    ]
    .iter()
    .cloned()
    .collect();
    let lambda: Expr = FuncValue::new(vec![FuncArg { idx: 1.into(), tpe: iv }], body).into();
    let expr: Expr = MethodCall::new(
        obj,
        MAP_METHOD.clone().with_concrete_types(&type_args),
        vec![lambda],
    )?
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let inner_json = match &val {
        Value::Opt(None) => None,
        Value::Opt(Some(boxed)) => Some(value_to_json(boxed)),
        other => anyhow::bail!("SOption.map fixture: expected Value::Opt, got {0:?}", other),
    };

    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: option_json(&ov, inner_json),
        expected_cost: ctx.jit_cost_value(),
    })
}

/// Lambda body `x > literal` (RelationOp::Gt) over an SLong arg → SBoolean.
fn body_gt_long(literal: i64) -> Expr {
    BinOp {
        kind: RelationOp::Gt.into(),
        left: Box::new(ValUse { val_id: 1.into(), tpe: SType::SLong }.into()),
        right: Box::new(Expr::Const(literal.into())),
    }
    .into()
}

/// Lambda body `x + literal` (ArithOp::Plus) over an arg of type `tpe`.
fn body_plus(tpe: SType, literal: Expr) -> Expr {
    BinOp {
        kind: ArithOp::Plus.into(),
        left: Box::new(ValUse { val_id: 1.into(), tpe }.into()),
        right: Box::new(literal),
    }
    .into()
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    // ⚠️ HAND-BLESSED (F3.5, 2026-06-07): the committed JSON costs for Some-path
    // entries (map_some_gt=119, map_some_plus_long=114, map_some_plus_int=114)
    // include ADD_TO_ENV_COST(5) per FuncValue application — JVM
    // AddToEnvironmentDesc, same class as apply.ts:74 and scoll-flat-map.ts:139.
    // The PINNED integration/ergots branch's soption.rs:map_eval does NOT charge
    // this 5 (bare env.insert; only the Fixed(20) envelope), so this generator
    // produces Some-path costs 5 lower (map_some_gt=114, map_some_plus_long/int=109).
    // NOTE: e-n-i's LambdaInvoker (eval.rs:396-406) ALREADY charges the 5 — after
    // any pin bump this regen-diff prediction inverts (no diff, nothing to
    // re-apply). JVM is canonical either way.
    // A regen diff on Some-path entries here is EXPECTED, not a regression — re-apply
    // the +5 to each Some-path expected_cost. None-path entries (map_none_gt=84,
    // map_none_int=84) are unaffected (lambda never invoked).
    // See packages/ergoscript/src/eval/soption-map.ts (F3.5).
    let entries = vec![
        // type-change Long→Bool (mirrors sigma-rust eval_map_some / eval_map_none).
        entry(
            "map_some_gt",
            box_with_r4(9999i64.into()),
            SType::SLong,
            SType::SBoolean,
            body_gt_long(0),
        )?,
        entry(
            "map_none_gt",
            box_no_registers(),
            SType::SLong,
            SType::SBoolean,
            body_gt_long(0),
        )?,
        // type-preserving Long→Long.
        entry(
            "map_some_plus_long",
            box_with_r4(5i64.into()),
            SType::SLong,
            SType::SLong,
            body_plus(SType::SLong, Expr::Const(1i64.into())),
        )?,
        // type-preserving Int→Int.
        entry(
            "map_some_plus_int",
            box_with_r4(3i32.into()),
            SType::SInt,
            SType::SInt,
            body_plus(SType::SInt, Expr::Const(1i32.into())),
        )?,
        entry(
            "map_none_int",
            box_no_registers(),
            SType::SInt,
            SType::SInt,
            body_plus(SType::SInt, Expr::Const(1i32.into())),
        )?,
    ];

    Ok(EvalFixtureFile {
        corpus: "eval_soption_map",
        entries,
    })
}
