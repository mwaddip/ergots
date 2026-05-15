//! Apply arm — fixtures for `Expr::Apply(...)` evaluation (bundles FuncValue + Apply).
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/apply.rs:12-56
//!   ctx.add_jit_cost(30)?; // Apply = Fixed(30) — BEFORE eval-func
//!   let func_v = self.func.eval(env, ctx)?;
//!   let args_v: Vec<Value> = self.args.iter().map(|a| a.eval(env, ctx)).collect()?;
//!   match func_v {
//!       Value::Lambda(fv) => { env save/restore; fv.body.eval(env, ctx) }
//!       _ => Err(...)
//!   }
//!
//! Lambda values aren't directly serializable via value_to_json. The
//! fixture bundles FuncValue + Apply so the assertion is on the body's
//! eval result (Boolean, Int, etc.) which IS serializable.
//!
//! Coverage (~10 entries):
//!   - Identity lambda: ((x: Int) => x)(42) → Int(42)
//!   - Constant body: ((x: Int) => 99)(1) → Int(99)
//!   - BinOp body: ((x: Int) => x + 1)(41) → Int(42)
//!   - Boolean identity: ((x: Boolean) => x)(true) → Boolean(true)
//!   - Multi-arg lambda: ((x: Int, y: Int) => x)(10, 20) → Int(10) (first arg)
//!   - Multi-arg second: ((x: Int, y: Int) => y)(10, 20) → Int(20) (second arg)
//!   - Free-variable via BlockValue: outer let-def accessible in body
//!   - Shadowing: arg shadows outer val-def with same id
//!   - Cost-limit at the Apply boundary

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::apply::Apply;
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind};
use ergotree_ir::mir::block::BlockValue;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::func_value::{FuncArg, FuncValue};
use ergotree_ir::mir::val_def::{ValDef, ValId};
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ApplyFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for error entries
    pub expected_value_json: JsonValue,
    /// 0 for error entries
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct ApplyFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ApplyFixture>,
}

fn build_tree(expr: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, expr: Expr) -> anyhow::Result<ApplyFixture> {
    let (tree, hex) = build_tree(expr)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ApplyFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn cost_limit_entry(name: &str, expr: Expr, limit: u64) -> anyhow::Result<ApplyFixture> {
    let (_tree, hex) = build_tree(expr)?;
    Ok(ApplyFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<ApplyFixtureFile> {
    let mut entries = Vec::new();

    // 1. Identity: ((x: Int) => x)(42) → Int(42)
    {
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![FuncArg { idx: ValId(1), tpe: SType::SInt }],
                Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt }),
            )
            .into(),
            vec![Expr::Const(42i32.into())],
        )
        .unwrap()
        .into();
        entries.push(success_entry("apply_identity_int", apply)?);
    }

    // 2. Constant body: ((x: Int) => 99)(1) → Int(99) (x not used)
    {
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![FuncArg { idx: ValId(1), tpe: SType::SInt }],
                Expr::Const(99i32.into()),
            )
            .into(),
            vec![Expr::Const(1i32.into())],
        )
        .unwrap()
        .into();
        entries.push(success_entry("apply_constant_body", apply)?);
    }

    // 3. BinOp body: ((x: Int) => x + 1)(41) → Int(42)
    {
        let body = BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
            right: Box::new(Expr::Const(1i32.into())),
        }
        .into();
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![FuncArg { idx: ValId(1), tpe: SType::SInt }],
                body,
            )
            .into(),
            vec![Expr::Const(41i32.into())],
        )
        .unwrap()
        .into();
        entries.push(success_entry("apply_binop_body", apply)?);
    }

    // 4. Boolean identity: ((x: Boolean) => x)(true) → Boolean(true)
    {
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![FuncArg { idx: ValId(1), tpe: SType::SBoolean }],
                Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SBoolean }),
            )
            .into(),
            vec![Expr::Const(true.into())],
        )
        .unwrap()
        .into();
        entries.push(success_entry("apply_identity_boolean", apply)?);
    }

    // 5. Boolean identity false: ((x: Boolean) => x)(false) → Boolean(false)
    {
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![FuncArg { idx: ValId(1), tpe: SType::SBoolean }],
                Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SBoolean }),
            )
            .into(),
            vec![Expr::Const(false.into())],
        )
        .unwrap()
        .into();
        entries.push(success_entry("apply_identity_boolean_false", apply)?);
    }

    // 6. Multi-arg, first: ((x: Int, y: Int) => x)(10, 20) → Int(10)
    {
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![
                    FuncArg { idx: ValId(1), tpe: SType::SInt },
                    FuncArg { idx: ValId(2), tpe: SType::SInt },
                ],
                Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt }),
            )
            .into(),
            vec![Expr::Const(10i32.into()), Expr::Const(20i32.into())],
        )
        .unwrap()
        .into();
        entries.push(success_entry("apply_multi_arg_first", apply)?);
    }

    // 7. Multi-arg, second: ((x: Int, y: Int) => y)(10, 20) → Int(20)
    {
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![
                    FuncArg { idx: ValId(1), tpe: SType::SInt },
                    FuncArg { idx: ValId(2), tpe: SType::SInt },
                ],
                Expr::ValUse(ValUse { val_id: ValId(2), tpe: SType::SInt }),
            )
            .into(),
            vec![Expr::Const(10i32.into()), Expr::Const(20i32.into())],
        )
        .unwrap()
        .into();
        entries.push(success_entry("apply_multi_arg_second", apply)?);
    }

    // 8. Free-variable via BlockValue: { val z = 100; ((x: Int) => x + z)(7) } → Int(107)
    //    The outer BlockValue defines z (ValId(3)); the lambda uses ValId(1) for x and
    //    ValId(3) for z. Validates that the caller's env (extended with arg binding) is
    //    correctly used for body eval (sigma-rust dynamic scoping).
    {
        let body = BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
            right: Box::new(Expr::ValUse(ValUse { val_id: ValId(3), tpe: SType::SInt })),
        }
        .into();
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![FuncArg { idx: ValId(1), tpe: SType::SInt }],
                body,
            )
            .into(),
            vec![Expr::Const(7i32.into())],
        )
        .unwrap()
        .into();
        // Wrap in BlockValue that defines z = 100 at ValId(3).
        let block: Expr = BlockValue {
            items: vec![ValDef {
                id: ValId(3),
                rhs: Box::new(Expr::Const(100i32.into())),
            }
            .into()],
            result: Box::new(apply),
        }
        .into();
        entries.push(success_entry("apply_free_variable", block)?);
    }

    // 9. Arg-eval: multiple args evaluated in order; last wins if same id not used
    //    ((x: Int) => x + x)(21) → Int(42) — arg used twice in body
    {
        let body = BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
            right: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
        }
        .into();
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![FuncArg { idx: ValId(1), tpe: SType::SInt }],
                body,
            )
            .into(),
            vec![Expr::Const(21i32.into())],
        )
        .unwrap()
        .into();
        entries.push(success_entry("apply_arg_used_twice", apply)?);
    }

    // 10. Cost-limit: jitCostLimit < Apply's 30 → throws on entry before eval-func
    {
        let apply: Expr = Apply::new(
            FuncValue::new(
                vec![FuncArg { idx: ValId(1), tpe: SType::SInt }],
                Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt }),
            )
            .into(),
            vec![Expr::Const(0i32.into())],
        )
        .unwrap()
        .into();
        entries.push(cost_limit_entry("apply_cost_limit", apply, 10)?);
    }

    Ok(ApplyFixtureFile { corpus: "eval_apply", entries })
}
