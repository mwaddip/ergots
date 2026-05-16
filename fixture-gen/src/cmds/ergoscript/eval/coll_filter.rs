//! Phase 2f Coll HOFs Task 7 — Filter eval fixtures (second lambda HOF).
//!
//! Cost: Mixed pattern.
//!   - Outer (after input/condition eval, before loop):
//!       `ctx.add_per_item_jit_cost(20, 1, 10, n)` where n = input.len()
//!   - Per-iter (inside closure, before body eval):
//!       `ctx.add_jit_cost(5)` per element
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/coll_filter.rs:15-90`
//!   line 20: let input_v = self.input.eval(env, ctx)?;
//!   line 21: let condition_v = self.condition.eval(env, ctx)?;
//!   line 31: ctx.add_jit_cost(5)?;           // per-iter cost inside closure
//!   line 52-58: if coll.elem_tpe() != &*self.elem_tpe → EvalError (elem-tpe check)
//!   line 61: ctx.add_per_item_jit_cost(20, 1, 10, n)?; // outer cost
//!   line 63-73: filter items using condition closure
//!
//! Key difference from Map: Filter checks `self.elem_tpe` (the MIR's declared elem_tpe
//! derived from the input's collection element type at construction time),
//! NOT the lambda's t_dom. In TS, where the Filter MIR has no `elemTpe` field,
//! we compare against the runtime `inputColl.elem` (same thing).
//!
//! Outer cost formula: `add_per_item_jit_cost(base=20, per_chunk=1, chunk_size=10, n)`:
//!   cost = base + per_chunk * ceil(n / chunk_size)
//!   For n=0:   20 + 1 * ceil(0/10)  = 20 + 0 = 20
//!   For n=3:   20 + 1 * ceil(3/10)  = 20 + 1 = 21
//!   For n=5:   20 + 1 * ceil(5/10)  = 20 + 1 = 21
//!   For n=12:  20 + 1 * ceil(12/10) = 20 + 2 = 22
//!
//! Total arm contribution = outer + sum(per-iter):
//!   n=0:   20 + 5*0  = 20
//!   n=3:   21 + 5*3  = 36
//!   n=5:   21 + 5*5  = 46
//!   n=12:  22 + 5*12 = 82
//!
//! (Costs above are arm-only contributions; sigma-rust's try_eval_out includes
//!  FuncValue(5) + other fixed costs from child exprs too.)
//!
//! Fixture entries (10 total):
//!   1. coll_filter_happy              — [1,2,3,4,5].filter(x => x > 2)  → [3,4,5]
//!   2. coll_filter_all_pass           — [1,2,3].filter(_ => true)        → [1,2,3]
//!   3. coll_filter_all_fail           — [1,2,3].filter(_ => false)       → []
//!   4. coll_filter_empty              — [].filter(_ => true)             → []  (outer cost only, n=0)
//!   5. coll_filter_sg_n12             — [0..12].filter(_ => true)        → [0..12] (n=12, outer=22)
//!      Compare with entry 1 (n=5): outer changes 21 → 22, proving chunking.
//!   6. coll_filter_not_coll           — Filter(Const(SInt,42), cond) → 'coll-input-not-coll'
//!      (synthetic: Filter::new validates, so raw bytes needed)
//!   7. coll_filter_cost_limit         — jitCostLimit too low → 'cost-limit-exceeded'
//!   8. coll_filter_elem_tpe_mismatch  — Coll[Int].filter but declared elem=SLong → 'coll-elem-tpe-mismatch'
//!      (synthetic: Filter struct direct construction)
//!   9. coll_filter_lambda_not_callable — condition is non-Lambda → 'lambda-not-callable'
//!      (synthetic: raw bytes — Filter::new requires condition to be SFunc)
//!  10. coll_filter_lambda_result_type_mismatch — body returns Int → 'lambda-result-type-mismatch'
//!      (If-trick: condition body is If(x==1, true, x) where exprTpe→SBoolean but x=2 returns Int)
//!
//! FILTER opcode = LAST_CONSTANT_CODE(112) + new_op_code(69) = 181 = 0xB5

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{BinOp, BinOpKind, RelationOp};
use ergotree_ir::mir::coll_filter::Filter;
use ergotree_ir::mir::if_op::If;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::func_value::{FuncArg, FuncValue};
use ergotree_ir::mir::val_def::ValId;
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct CollFilterFixture {
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
pub struct CollFilterFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CollFilterFixture>,
}

/// Build a Filter expr: `input.filter(x => body)` where `x` is bound to `ValId(1)`.
/// `x_tpe` is the element type of `input` (= condition lambda's arg type).
/// Body must have type SBoolean (be a predicate).
fn build_filter(input: Expr, x_tpe: SType, body: Expr) -> anyhow::Result<Expr> {
    let condition: Expr = FuncValue::new(
        vec![FuncArg { idx: ValId(1), tpe: x_tpe }],
        body,
    )
    .into();
    Ok(Filter::new(input, condition)?.into())
}

fn build_tree(expr: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, expr: Expr) -> anyhow::Result<CollFilterFixture> {
    let (tree, hex) = build_tree(expr)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(CollFilterFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn cost_limit_entry(name: &str, expr: Expr, limit: u64) -> anyhow::Result<CollFilterFixture> {
    let (_tree, hex) = build_tree(expr)?;
    Ok(CollFilterFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<CollFilterFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. coll_filter_happy ──────────────────────────────────────────────────
    // [1,2,3,4,5].filter(x => x > 2) → [3,4,5]
    // x: SInt; body = x > 2 (BinOp GT)
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32, 4i32, 5i32].into());
        let body: Expr = BinOp {
            kind: BinOpKind::Relation(RelationOp::Gt),
            left: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
            right: Box::new(Expr::Const(2i32.into())),
        }
        .into();
        let expr = build_filter(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_filter_happy", expr)?);
    }

    // ── 2. coll_filter_all_pass ───────────────────────────────────────────────
    // [1,2,3].filter(_ => true) → [1,2,3]
    // All items pass the always-true predicate.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let body: Expr = Expr::Const(true.into());
        let expr = build_filter(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_filter_all_pass", expr)?);
    }

    // ── 3. coll_filter_all_fail ───────────────────────────────────────────────
    // [1,2,3].filter(_ => false) → []
    // All items fail — result is empty Coll[Int].
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let body: Expr = Expr::Const(false.into());
        let expr = build_filter(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_filter_all_fail", expr)?);
    }

    // ── 4. coll_filter_empty ─────────────────────────────────────────────────
    // [].filter(_ => true) → []
    // Empty input — outer cost only (n=0 → outer=20), zero per-iter.
    {
        let coll: Expr = Expr::Const(Vec::<i32>::new().into());
        let body: Expr = Expr::Const(true.into());
        let expr = build_filter(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_filter_empty", expr)?);
    }

    // ── 5. coll_filter_sg_n12 ────────────────────────────────────────────────
    // [0..12].filter(_ => true) → [0,1,...,11]  (n=12, all pass)
    // Smoking-gun: n=12, outer=ceil(12/10)*1 + 20 = 22.
    // Per-iter = 12 * 5 = 60. Compare entry 1 (n=5, outer=21): proves chunking.
    {
        let items: Vec<i32> = (0i32..12).collect();
        let coll: Expr = Expr::Const(items.into());
        let body: Expr = Expr::Const(true.into());
        let expr = build_filter(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_filter_sg_n12", expr)?);
    }

    // ── 6. coll_filter_not_coll ──────────────────────────────────────────────
    // Filter(Const(SInt, 42), cond) → 'coll-input-not-coll'
    //
    // `Filter::new` validates that input is SColl — bypass via raw bytes.
    // FILTER opcode = LAST_CONSTANT_CODE(112) + new_op_code(69) = 181 = 0xB5
    //
    // Raw layout:
    //   [0x00]  ErgoTreeHeader v0(false)
    //   [0xB5]  FILTER opcode
    //   [int_const_bytes]    Const(SInt, 42)
    //   [condition_bytes]    FuncValue((x: SInt) => true)
    {
        let int_const: Expr = Expr::Const(42i32.into());
        let condition: Expr = FuncValue::new(
            vec![FuncArg { idx: ValId(1), tpe: SType::SInt }],
            Expr::Const(true.into()),
        )
        .into();

        let const_bytes = int_const.sigma_serialize_bytes()?;
        let cond_bytes = condition.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8); // ErgoTreeHeader v0(false) → 0x00
        tree_bytes.push(0xB5u8); // FILTER opcode = 112 + 69 = 181 = 0xB5
        tree_bytes.extend_from_slice(&const_bytes);
        tree_bytes.extend_from_slice(&cond_bytes);

        entries.push(CollFilterFixture {
            name: "coll_filter_not_coll".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-input-not-coll"),
        });
    }

    // ── 7. coll_filter_cost_limit ─────────────────────────────────────────────
    // jitCostLimit too low → cost-limit-exceeded before eval completes.
    // Limit = 1 guarantees the very first charge overflows.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let body: Expr = Expr::Const(true.into());
        let expr = build_filter(coll, SType::SInt, body)?;
        entries.push(cost_limit_entry("coll_filter_cost_limit", expr, 1)?);
    }

    // ── 8. coll_filter_elem_tpe_mismatch ─────────────────────────────────────
    // Coll[Int].filter but Filter's declared elem_tpe = SLong → 'coll-elem-tpe-mismatch'
    //
    // sigma-rust coll_filter.rs:52-58: `if coll.elem_tpe() != &*self.elem_tpe → EvalError`.
    // Filter::new derives elem_tpe from input SColl, so we must construct Filter directly.
    //
    // We build Filter with:
    //   - input: Coll[Int] (runtime elem = SInt)
    //   - elem_tpe: SLong (mismatches SInt → triggers the check)
    //   - condition: valid FuncValue with SLong arg (type matches elem_tpe for wire validity)
    //
    // We do NOT call sigma-rust try_eval_out — it would return EvalError.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32].into()); // Coll[Int] at runtime
        // Condition: (x: SLong) => true — type system sees SLong, runtime would see SInt elem
        let condition: Expr = FuncValue::new(
            vec![FuncArg { idx: ValId(1), tpe: SType::SLong }],
            Expr::Const(true.into()),
        )
        .into();
        // Construct Filter directly with mismatched elem_tpe (SLong vs runtime SInt)
        use std::sync::Arc;
        let filter_expr: Expr = Filter {
            input: Box::new(coll),
            condition: Box::new(condition),
            elem_tpe: Arc::new(SType::SLong),
        }
        .into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &filter_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollFilterFixture {
            name: "coll_filter_elem_tpe_mismatch".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-elem-tpe-mismatch"),
        });
    }

    // ── 9. coll_filter_lambda_not_callable ───────────────────────────────────
    // Filter(Coll[Int], Const(SBoolean, true)) → 'lambda-not-callable'
    //
    // Condition is a Const (not a FuncValue) so evaluating it yields a Boolean SValue
    // (not a Lambda), which extractFuncValue rejects.
    //
    // Filter::new requires condition.tpe() == SFunc, so Const(true) is rejected at
    // construction time. Use raw bytes (FILTER opcode) to bypass.
    //
    // Raw layout:
    //   [0x00]  ErgoTreeHeader v0(false)
    //   [0xB5]  FILTER opcode
    //   [coll_bytes]    Const(Coll[Int], [1,2,3])
    //   [const_bytes]   Const(SBoolean, true)
    //
    // We do NOT call sigma-rust try_eval_out — it would error.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let const_cond: Expr = Expr::Const(true.into());

        let coll_bytes = coll.sigma_serialize_bytes()?;
        let const_bytes = const_cond.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8);
        tree_bytes.push(0xB5u8); // FILTER opcode
        tree_bytes.extend_from_slice(&coll_bytes);
        tree_bytes.extend_from_slice(&const_bytes);

        entries.push(CollFilterFixture {
            name: "coll_filter_lambda_not_callable".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("lambda-not-callable"),
        });
    }

    // ── 10. coll_filter_lambda_result_type_mismatch ──────────────────────────
    // [1, 2].filter(x => if (x == 1) { true } else { x }) → 'lambda-result-type-mismatch'
    //
    // The condition body is `If(x==1, true, x)`. Its compile-time type (true-branch type)
    // is SBoolean (since `If::tpe` returns the true-branch type → Const(true).tpe() → SBoolean).
    // FuncValue::new computes t_range = body.tpe() = SBoolean.
    //
    // At eval time:
    //   - item x=1: condition true  → returns Boolean(true) → type SBoolean = expected → OK → kept
    //   - item x=2: condition false → returns Int(2)        → type SInt ≠ SBoolean → THROWS
    //
    // TS: Filter body must return Boolean. Runtime mismatch on x=2 triggers
    // 'lambda-result-type-mismatch'.
    //
    // Filter::new validates t_dom[0] == input_elem SInt and t_range == SBoolean →
    // If's tpe is SBoolean, so Filter::new accepts this. We use the standard build path.
    // We do NOT call sigma-rust try_eval_out — it would error because try_extract_into::<bool>()
    // on Int(2) fails.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32].into()); // Coll[Int]
        let x_use: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt });
        // condition: x == 1
        let cond_expr: Expr = BinOp {
            kind: BinOpKind::Relation(RelationOp::Eq),
            left: Box::new(x_use.clone()),
            right: Box::new(Expr::Const(1i32.into())),
        }
        .into();
        // body: if (x == 1) { true } else { x }
        // If::tpe() = true_branch.tpe() = SBoolean
        // false_branch = x (SInt at runtime) — type mismatch at runtime!
        let body: Expr = If {
            condition: Box::new(cond_expr),
            true_branch: Box::new(Expr::Const(true.into())),
            false_branch: Box::new(x_use),
        }
        .into();
        // FuncValue::new: t_dom=[SInt], t_range = body.tpe() = SBoolean
        // Filter::new: condition.tpe() = SFunc{t_dom=[SInt], t_range=SBoolean} → OK
        let expr = build_filter(coll, SType::SInt, body)?;
        let (_tree, hex) = build_tree(expr)?;

        entries.push(CollFilterFixture {
            name: "coll_filter_lambda_result_type_mismatch".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("lambda-result-type-mismatch"),
        });
    }

    Ok(CollFilterFixtureFile {
        corpus: "eval_coll_filter",
        entries,
    })
}
