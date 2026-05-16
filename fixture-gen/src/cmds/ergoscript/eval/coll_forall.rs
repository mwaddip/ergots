//! Phase 2f Coll HOFs Task 10 — ForAll eval fixtures (fifth and final lambda HOF).
//!
//! Short-circuits on first `false`; returns `true` for empty input.
//!
//! Cost: Mixed pattern — outer charged on FULL input length BEFORE the loop;
//! per-iter charged only for VISITED items.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/coll_forall.rs:12-69`
//!   line 18: let input_v = self.input.eval(env, ctx)?;
//!   line 19: let condition_v = self.condition.eval(env, ctx)?;
//!   line 29: ctx.add_jit_cost(5)?;                          // per-iter (inside closure)
//!   line 46-58: elem_tpe check: coll.elem_tpe() != &*self.elem_tpe
//!   line 60: ctx.add_per_item_jit_cost(3, 1, 10, n)?;       // outer (BEFORE loop, FULL n)
//!   line 62-66: for item in normalized_input_vals { ... if !res { return false; } }
//!   line 68: Ok(true.into())   // all pass or empty
//!
//! CRITICAL: Outer cost at line 60 is AFTER children are evaluated and AFTER the
//! elem_tpe check, but BEFORE the for-item loop at line 62. It charges the FULL
//! input length regardless of how many items are visited due to short-circuiting.
//!
//! Outer cost formula: `add_per_item_jit_cost(base=3, per_chunk=1, chunk_size=10, n)`:
//!   cost = base + per_chunk * ceil(n / chunk_size)
//!   For n=0:    3 + 1 * ceil(0/10)    = 3 + 0   = 3
//!   For n=3:    3 + 1 * ceil(3/10)    = 3 + 1   = 4
//!   For n=12:   3 + 1 * ceil(12/10)   = 3 + 2   = 5
//!   For n=1000: 3 + 1 * ceil(1000/10) = 3 + 100 = 103
//!
//! Smoking-gun: n=1000, short-circuit at item 1.
//!   Outer = addPerItemCost(3, 1, 10, 1000) = 103 (FULL length).
//!   Per-iter = 1 * 5 = 5 (only item 1 visited).
//!   Arm contribution = 103 + 5 = 108 (plus child eval costs).
//!   This proves the outer charges FULL n, not the visited count.
//!
//! FORALL opcode = LAST_CONSTANT_CODE(112) + new_op_code(63) = 175 = 0xAF
//!
//! Fixture entries (10 total):
//!   1. coll_forall_happy                     — [1,2,3].forall(x => x > 0)  → Boolean(true) (all pass)
//!   2. coll_forall_sg_full_outer_cost         — [false, true, true, ..., true].forall(x => x) — n=1000, short-circuit at item 1.
//!      Smoking-gun: outer=103, per-iter=5, arm=108. NOT outer(n=1)+5=9.
//!   3. coll_forall_some_fail                 — [1,2,3].forall(x => x > 0) → Boolean(true)   (all visited)
//!   4. coll_forall_empty                     — [].forall(_ => false)        → Boolean(true) (NOTE: opposite of Exists's false)
//!   5. coll_forall_sg_n12                    — n=12, all true, proves outer chunking
//!   6. coll_forall_elem_tpe_mismatch         — input SInt, declared elem SLong → 'coll-elem-tpe-mismatch'
//!   7. coll_forall_lambda_not_callable       — condition is non-Lambda → 'lambda-not-callable'
//!   8. coll_forall_lambda_result_type_mismatch — body returns Int → 'lambda-result-type-mismatch'
//!   9. coll_forall_not_coll                  — input is SInt → 'coll-input-not-coll'
//!  10. coll_forall_cost_limit                — jitCostLimit too low → 'cost-limit-exceeded'

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{BinOp, BinOpKind, RelationOp};
use ergotree_ir::mir::coll_forall::ForAll;
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
pub struct CollForAllFixture {
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
pub struct CollForAllFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CollForAllFixture>,
}

/// Build a ForAll expr: `input.forall(x => body)` where `x` is bound to `ValId(1)`.
/// `x_tpe` is the element type of `input` (= condition lambda's arg type).
/// Body must have type SBoolean.
fn build_forall(input: Expr, x_tpe: SType, body: Expr) -> anyhow::Result<Expr> {
    let condition: Expr = FuncValue::new(
        vec![FuncArg { idx: ValId(1), tpe: x_tpe }],
        body,
    )
    .into();
    Ok(ForAll::new(input, condition)?.into())
}

fn build_tree(expr: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, expr: Expr) -> anyhow::Result<CollForAllFixture> {
    let (tree, hex) = build_tree(expr)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(CollForAllFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn cost_limit_entry(name: &str, expr: Expr, limit: u64) -> anyhow::Result<CollForAllFixture> {
    let (_tree, hex) = build_tree(expr)?;
    Ok(CollForAllFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<CollForAllFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. coll_forall_happy ──────────────────────────────────────────────────
    // [1,2,3].forall(x => x > 0) → Boolean(true)
    // All items pass (x > 0); all 3 visited (no short-circuit).
    // x: SInt; body = x > 0 (BinOp GT)
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let body: Expr = BinOp {
            kind: BinOpKind::Relation(RelationOp::Gt),
            left: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
            right: Box::new(Expr::Const(0i32.into())),
        }
        .into();
        let expr = build_forall(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_forall_happy", expr)?);
    }

    // ── 2. coll_forall_sg_full_outer_cost ────────────────────────────────────
    // SMOKING-GUN: [false, true, true, ..., true].forall(x => x) — n=1000, false at item 1.
    //
    // Critical subtlety: outer cost at sigma-rust coll_forall.rs:60 is charged BEFORE
    // the for-loop (line 62) using the FULL input length, even though short-circuit
    // exits after item 1.
    //
    // Expected arm contribution:
    //   outer = addPerItemCost(3, 1, 10, 1000) = 3 + ceil(1000/10)*1 = 3 + 100 = 103
    //   per-iter = 1 * 5 = 5  (only item 1 visited before short-circuit)
    //   arm total = 108
    //
    // This is NOT outer(3, 1, 10, 1) + 5 = 4 + 5 = 9 (wrong — would happen if outer
    // charged only visited items).
    //
    // x: SBoolean; body = x (ValUse directly, returns the boolean element)
    // Input: [false, true, true, ..., true] — 1000 items, first is false.
    {
        let mut items = vec![true; 1000];
        items[0] = false; // first item is false → short-circuit at item 1
        let coll: Expr = Expr::Const(items.into());
        // body = x (the element itself, type SBoolean)
        let body: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SBoolean });
        let expr = build_forall(coll, SType::SBoolean, body)?;
        entries.push(success_entry("coll_forall_sg_full_outer_cost", expr)?);
    }

    // ── 3. coll_forall_some_fail ──────────────────────────────────────────────
    // [1,2,3].forall(x => x > 0) → Boolean(true)
    // All items pass; all 3 visited (no short-circuit in this scenario).
    // Same as happy but emphasizes all-visit behavior.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let body: Expr = BinOp {
            kind: BinOpKind::Relation(RelationOp::Gt),
            left: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
            right: Box::new(Expr::Const(0i32.into())),
        }
        .into();
        let expr = build_forall(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_forall_some_fail", expr)?);
    }

    // ── 4. coll_forall_empty ──────────────────────────────────────────────────
    // [].forall(_ => false) → Boolean(true)
    // Empty input — loop never runs. Per-iter = 0. Outer = addPerItemCost(3, 1, 10, 0) = 3.
    // Returns true (sigma-rust coll_forall.rs:68: Ok(true.into())).
    // NOTE: This is the OPPOSITE of Exists's empty default (false).
    {
        let coll: Expr = Expr::Const(Vec::<bool>::new().into());
        let body: Expr = Expr::Const(false.into());
        let expr = build_forall(coll, SType::SBoolean, body)?;
        entries.push(success_entry("coll_forall_empty", expr)?);
    }

    // ── 5. coll_forall_sg_n12 ────────────────────────────────────────────────
    // n=12, all true — smoking-gun for chunked outer cost.
    // n=3:  outer = 3 + ceil(3/10)*1  = 3 + 1 = 4
    // n=12: outer = 3 + ceil(12/10)*1 = 3 + 2 = 5
    // Proves outer changes at chunk boundary (no short-circuit: all 12 visited).
    {
        let items = vec![true; 12];
        let coll: Expr = Expr::Const(items.into());
        let body: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SBoolean });
        let expr = build_forall(coll, SType::SBoolean, body)?;
        entries.push(success_entry("coll_forall_sg_n12", expr)?);
    }

    // ── 6. coll_forall_elem_tpe_mismatch ─────────────────────────────────────
    // Coll[Int].forall but ForAll's declared elem_tpe = SLong → 'coll-elem-tpe-mismatch'
    //
    // Sigma-rust coll_forall.rs:46-52: `if coll.elem_tpe() != &*self.elem_tpe → EvalError`.
    // ForAll::new derives elem_tpe from input SColl, so we must construct ForAll directly.
    //
    // We build ForAll with:
    //   - input: Coll[Int] (runtime elem = SInt)
    //   - elem_tpe: SLong (mismatches SInt → triggers the check)
    //   - condition: valid FuncValue with SLong arg (for TS: condition.args[0].tpe = SLong)
    //
    // We do NOT call sigma-rust try_eval_out — it would return EvalError.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32].into()); // Coll[Int] at runtime
        // Condition: (x: SLong) => true — declared arg is SLong, but runtime elem is SInt
        let condition: Expr = FuncValue::new(
            vec![FuncArg { idx: ValId(1), tpe: SType::SLong }],
            Expr::Const(true.into()),
        )
        .into();
        // Construct ForAll directly with mismatched elem_tpe (SLong vs runtime SInt)
        use std::sync::Arc;
        let forall_expr: Expr = ForAll {
            input: Box::new(coll),
            condition: Box::new(condition),
            elem_tpe: Arc::new(SType::SLong),
        }
        .into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &forall_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollForAllFixture {
            name: "coll_forall_elem_tpe_mismatch".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-elem-tpe-mismatch"),
        });
    }

    // ── 7. coll_forall_lambda_not_callable ───────────────────────────────────
    // ForAll(Coll[Int], Const(SBoolean, true)) → 'lambda-not-callable'
    //
    // Condition is a Const (not a FuncValue) so evaluating it yields a Boolean SValue
    // (not a Lambda), which extractFuncValue rejects.
    //
    // ForAll::new requires condition.tpe() == SFunc — Const(true) has type SBoolean.
    // Use raw bytes (FORALL opcode = 0xAF) to bypass.
    //
    // Raw layout:
    //   [0x00]  ErgoTreeHeader v0(false)
    //   [0xAF]  FORALL opcode = 112 + 63 = 175 = 0xAF
    //   [coll_bytes]   Const(Coll[Int], [1,2,3])
    //   [const_bytes]  Const(SBoolean, true)
    //
    // We do NOT call sigma-rust try_eval_out — it would error.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let const_cond: Expr = Expr::Const(true.into());

        let coll_bytes = coll.sigma_serialize_bytes()?;
        let const_bytes = const_cond.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8); // ErgoTreeHeader v0(false)
        tree_bytes.push(0xAFu8); // FORALL opcode = 112 + 63 = 175 = 0xAF
        tree_bytes.extend_from_slice(&coll_bytes);
        tree_bytes.extend_from_slice(&const_bytes);

        entries.push(CollForAllFixture {
            name: "coll_forall_lambda_not_callable".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("lambda-not-callable"),
        });
    }

    // ── 8. coll_forall_lambda_result_type_mismatch ───────────────────────────
    // [2, 1].forall(x => if (x == 1) { true } else { x }) → 'lambda-result-type-mismatch'
    //
    // The condition body is `If(x==1, true, x)`. Its compile-time type (true-branch type)
    // is SBoolean (If::tpe returns true-branch type → Const(true).tpe() → SBoolean).
    // FuncValue::new computes t_range = body.tpe() = SBoolean.
    //
    // At eval time:
    //   - item x=2: condition false → returns Int(2) → type SInt ≠ SBoolean → THROWS
    //   (we never reach x=1)
    //
    // ForAll (unlike Exists) short-circuits on false, NOT on true.
    // x=2 gives false-branch = x (SInt), which is a type mismatch.
    //
    // TS: ForAll body must return Boolean. Runtime mismatch on x=2 triggers
    // 'lambda-result-type-mismatch'.
    //
    // ForAll::new validates t_range == SBoolean (If's tpe is SBoolean), so the
    // standard build path accepts this. We do NOT call sigma-rust try_eval_out —
    // it would error because try_extract_into::<bool>() on Int(2) fails.
    {
        let coll: Expr = Expr::Const(vec![2i32, 1i32].into()); // Coll[Int] — 2 first!
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
        // false_branch = x (SInt at runtime) — type mismatch on x=2!
        let body: Expr = If {
            condition: Box::new(cond_expr),
            true_branch: Box::new(Expr::Const(true.into())),
            false_branch: Box::new(x_use),
        }
        .into();
        let expr = build_forall(coll, SType::SInt, body)?;
        let (_tree, hex) = build_tree(expr)?;

        entries.push(CollForAllFixture {
            name: "coll_forall_lambda_result_type_mismatch".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("lambda-result-type-mismatch"),
        });
    }

    // ── 9. coll_forall_not_coll ───────────────────────────────────────────────
    // ForAll(Const(SInt, 42), cond) → 'coll-input-not-coll'
    //
    // `ForAll::new` validates that input is SColl — bypass via raw bytes.
    // FORALL opcode = LAST_CONSTANT_CODE(112) + new_op_code(63) = 175 = 0xAF
    //
    // Raw layout:
    //   [0x00]  ErgoTreeHeader v0(false)
    //   [0xAF]  FORALL opcode
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
        tree_bytes.push(0xAFu8); // FORALL opcode = 112 + 63 = 175 = 0xAF
        tree_bytes.extend_from_slice(&const_bytes);
        tree_bytes.extend_from_slice(&cond_bytes);

        entries.push(CollForAllFixture {
            name: "coll_forall_not_coll".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-input-not-coll"),
        });
    }

    // ── 10. coll_forall_cost_limit ────────────────────────────────────────────
    // jitCostLimit too low → cost-limit-exceeded before eval completes.
    // Limit = 1 guarantees the very first charge overflows.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let body: Expr = Expr::Const(true.into());
        let expr = build_forall(coll, SType::SInt, body)?;
        entries.push(cost_limit_entry("coll_forall_cost_limit", expr, 1)?);
    }

    Ok(CollForAllFixtureFile {
        corpus: "eval_coll_forall",
        entries,
    })
}
