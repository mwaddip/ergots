//! Phase 2f Coll HOFs Task 2 — SizeOf eval fixtures.
//!
//! Cost: Fixed(14). Pattern A (cost BEFORE eval-child).
//! Sigma-rust ref: `ergotree-interpreter/src/eval/coll_size.rs:11-22`
//!   ctx.add_jit_cost(14)?;                      // line 15 — Pattern A
//!   let input_v = self.input.eval(env, ctx)?;   // line 16
//!   match input_v {
//!     Value::Coll(coll) => Ok((coll.len() as i32).into()),
//!     _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! Fixture entries (6 total):
//!   1. coll_size_int_5         — Coll[Int]([10,20,30,40,50]) → Int(5)
//!   2. coll_size_empty         — Coll[Int]([]) → Int(0)
//!   3. coll_size_long_3        — Coll[Long]([1L,2L,3L]) → Int(3)
//!   4. coll_size_nested_2      — Coll[Coll[Byte]] of length 2 → Int(2)
//!   5. coll_size_cost_limit    — jitCostLimit=10 < Fixed(14) → cost-limit-exceeded
//!   6. coll_size_not_coll      — SizeOf(Const(SInt,42)) → coll-input-not-coll
//!
//! Notes on entry 6:
//!   `SizeOf::try_build` rejects non-SColl inputs at construction time.
//!   We construct `SizeOf { input }` directly (field is pub) to bypass that
//!   guard and produce a tree the TS parser (permissive) accepts but our eval
//!   throws `'coll-input-not-coll'` on. We do NOT call sigma-rust's evaluator
//!   for this entry — it would return a Rust EvalError, and we only need the
//!   bytes to test the TS-side guard.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::coll_size::SizeOf;
use ergotree_ir::mir::collection::Collection;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct CollSizeFixture {
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
pub struct CollSizeFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CollSizeFixture>,
}

pub fn generate() -> anyhow::Result<CollSizeFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. coll_size_int_5 ────────────────────────────────────────────────────
    // SizeOf(Coll[Int]([10, 20, 30, 40, 50])) → Int(5)
    // Cost: 14 (SizeOf) + 20 (ConcreteCollection) + 5×5 (Const each) = 59
    {
        let items: Vec<Expr> = vec![
            Expr::Const(10i32.into()),
            Expr::Const(20i32.into()),
            Expr::Const(30i32.into()),
            Expr::Const(40i32.into()),
            Expr::Const(50i32.into()),
        ];
        let coll: Expr = Collection::new(SType::SInt, items)?.into();
        let expr: Expr = SizeOf { input: Box::new(coll) }.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, Value::Int(5)),
            "expected Int(5), got {:?}",
            val
        );

        entries.push(CollSizeFixture {
            name: "coll_size_int_5".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 2. coll_size_empty ────────────────────────────────────────────────────
    // SizeOf(Coll[Int]([])) → Int(0)
    // Cost: 14 (SizeOf) + 20 (ConcreteCollection, empty) = 34
    {
        let coll: Expr = Collection::new(SType::SInt, vec![])?.into();
        let expr: Expr = SizeOf { input: Box::new(coll) }.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, Value::Int(0)),
            "expected Int(0), got {:?}",
            val
        );

        entries.push(CollSizeFixture {
            name: "coll_size_empty".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 3. coll_size_long_3 ───────────────────────────────────────────────────
    // SizeOf(Coll[Long]([1L, 2L, 3L])) → Int(3)
    // Cost: 14 (SizeOf) + 20 (ConcreteCollection) + 5×3 (Const each) = 49
    {
        let items: Vec<Expr> = vec![
            Expr::Const(1i64.into()),
            Expr::Const(2i64.into()),
            Expr::Const(3i64.into()),
        ];
        let coll: Expr = Collection::new(SType::SLong, items)?.into();
        let expr: Expr = SizeOf { input: Box::new(coll) }.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, Value::Int(3)),
            "expected Int(3), got {:?}",
            val
        );

        entries.push(CollSizeFixture {
            name: "coll_size_long_3".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 4. coll_size_nested_2 ─────────────────────────────────────────────────
    // SizeOf(Coll[Coll[Byte]]([inner1, inner2])) → Int(2)
    // inner1 = Coll[Byte]([0]); inner2 = Coll[Byte]([1, 2])
    // Cost: oracle-recorded (ctx.jit_cost_value()).
    {
        let inner1: Expr = Collection::new(
            SType::SByte,
            vec![Expr::Const(0i8.into())],
        )?
        .into();
        let inner2: Expr = Collection::new(
            SType::SByte,
            vec![Expr::Const(1i8.into()), Expr::Const(2i8.into())],
        )?
        .into();
        let outer: Expr =
            Collection::new(SType::SColl(SType::SByte.into()), vec![inner1, inner2])?.into();
        let expr: Expr = SizeOf { input: Box::new(outer) }.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, Value::Int(2)),
            "expected Int(2), got {:?}",
            val
        );

        entries.push(CollSizeFixture {
            name: "coll_size_nested_2".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 5. coll_size_cost_limit ───────────────────────────────────────────────
    // jitCostLimit=10 < Fixed(14) → 'cost-limit-exceeded'
    // Same tree as entry 2 (SizeOf(Coll[Int]([]))).
    // Pattern A: addCost(14) fires before eval-child, exceeds limit=10.
    {
        let coll: Expr = Collection::new(SType::SInt, vec![])?.into();
        let expr: Expr = SizeOf { input: Box::new(coll) }.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollSizeFixture {
            name: "coll_size_cost_limit".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "jitCostLimit": 10 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("cost-limit-exceeded"),
        });
    }

    // ── 6. coll_size_not_coll ─────────────────────────────────────────────────
    // SizeOf(Const(SInt, 42)) — non-Coll input → 'coll-input-not-coll'
    //
    // `SizeOf::try_build` rejects non-SColl inputs. We bypass it by constructing
    // `SizeOf { input: Box::new(Const(42i32)) }` directly (field is pub).
    // The TS parser (permissive, no type-checking at wire layer) accepts the bytes.
    // The TS eval throws `'coll-input-not-coll'` when `extractCollItems` sees
    // the Int SValue returned by Const.
    //
    // We do NOT call sigma-rust try_eval_out here — sigma-rust returns
    // EvalError::UnexpectedValue which would panic the assert; this entry
    // is a TS-only guard test.
    {
        let const_expr: Expr = Expr::Const(42i32.into());
        let expr: Expr = SizeOf { input: Box::new(const_expr) }.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollSizeFixture {
            name: "coll_size_not_coll".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-input-not-coll"),
        });
    }

    Ok(CollSizeFixtureFile {
        corpus: "eval_coll_size",
        entries,
    })
}
