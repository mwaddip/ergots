//! Phase 2f Coll HOFs Task 3 — Append eval fixtures.
//!
//! Cost: `add_per_item_jit_cost(20, 2, 100, n1+n2)`. Pattern B-chunked
//! (cost AFTER both child evals).
//! Sigma-rust ref: `ergotree-interpreter/src/eval/coll_append.rs:39-63`
//!   let input_v = self.input.eval(env, ctx)?;         // line 44
//!   let col2_v = self.col_2.eval(env, ctx)?;          // line 45
//!   ...
//!   ctx.add_per_item_jit_cost(20, 2, 100, n1+n2)?;   // line 57 — Pattern B
//!   Ok(concat result)
//!
//! Fixture entries (9 total):
//!   1. coll_append_int_4_4       — [1,2,3,4] ++ [5,6,7,8] → [1,2,3,4,5,6,7,8]
//!   2. coll_append_empty_lhs     — [] ++ [1,2,3] → [1,2,3]
//!   3. coll_append_empty_rhs     — [1,2,3] ++ [] → [1,2,3]
//!   4. coll_append_both_empty    — [] ++ [] → []
//!   5. coll_append_byte          — [0x01,0x02] ++ [0x03] → [0x01,0x02,0x03]
//!   6. coll_append_cost_eq_lhs   — [1..100] ++ [] → same Append cost as entry 7
//!   7. coll_append_cost_eq_rhs   — [] ++ [1..100] → same Append cost as entry 6
//!   8. coll_append_elem_tpe_mismatch — Coll[Int] ++ Coll[Long] → coll-elem-tpe-mismatch
//!   9. coll_append_not_coll      — Append(Const(SInt,42), Coll[Int]([])) → coll-input-not-coll
//!
//! Notes on entry 8 (elem-tpe-mismatch):
//!   `Append::new` rejects inputs with differing elem types at construction time.
//!   We construct `Append { input: Box::new(int_coll), col_2: Box::new(long_coll) }`
//!   directly (fields are pub) to bypass that guard. The TS parser (permissive)
//!   accepts the bytes; our eval throws `'coll-elem-tpe-mismatch'`.
//!   We do NOT call sigma-rust's evaluator for this entry.
//!
//! Notes on entry 9 (non-Coll input):
//!   Similarly bypasses `Append::new` validation by constructing the struct
//!   directly with a non-Coll Expr as `input`. TS eval throws `'coll-input-not-coll'`.
//!   We do NOT call sigma-rust's evaluator for this entry.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::coll_append::Append;
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
pub struct CollAppendFixture {
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
pub struct CollAppendFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CollAppendFixture>,
}

pub fn generate() -> anyhow::Result<CollAppendFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. coll_append_int_4_4 ───────────────────────────────────────────────
    // [1,2,3,4] ++ [5,6,7,8] → [1,2,3,4,5,6,7,8]
    // Append cost (Pattern B): add_per_item_jit_cost(20, 2, 100, 8) = 20 + 1*2 = 22
    // (plus ConcreteCollection costs for each child).
    {
        let lhs: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(1i32.into()),
                Expr::Const(2i32.into()),
                Expr::Const(3i32.into()),
                Expr::Const(4i32.into()),
            ],
        )?
        .into();
        let rhs: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(5i32.into()),
                Expr::Const(6i32.into()),
                Expr::Const(7i32.into()),
                Expr::Const(8i32.into()),
            ],
        )?
        .into();
        let expr: Expr = Append::new(lhs, rhs)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollAppendFixture {
            name: "coll_append_int_4_4".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 2. coll_append_empty_lhs ─────────────────────────────────────────────
    // [] ++ [1,2,3] → [1,2,3]
    // Append cost: add_per_item_jit_cost(20, 2, 100, 3) = 20 + 1*2 = 22
    {
        let lhs: Expr = Collection::new(SType::SInt, vec![])?.into();
        let rhs: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(1i32.into()),
                Expr::Const(2i32.into()),
                Expr::Const(3i32.into()),
            ],
        )?
        .into();
        let expr: Expr = Append::new(lhs, rhs)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollAppendFixture {
            name: "coll_append_empty_lhs".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 3. coll_append_empty_rhs ─────────────────────────────────────────────
    // [1,2,3] ++ [] → [1,2,3]
    // Append cost: add_per_item_jit_cost(20, 2, 100, 3) = 20 + 1*2 = 22
    {
        let lhs: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(1i32.into()),
                Expr::Const(2i32.into()),
                Expr::Const(3i32.into()),
            ],
        )?
        .into();
        let rhs: Expr = Collection::new(SType::SInt, vec![])?.into();
        let expr: Expr = Append::new(lhs, rhs)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollAppendFixture {
            name: "coll_append_empty_rhs".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 4. coll_append_both_empty ────────────────────────────────────────────
    // [] ++ [] → []
    // Append cost: add_per_item_jit_cost(20, 2, 100, 0) = 20 + 0 = 20
    {
        let lhs: Expr = Collection::new(SType::SInt, vec![])?.into();
        let rhs: Expr = Collection::new(SType::SInt, vec![])?.into();
        let expr: Expr = Append::new(lhs, rhs)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollAppendFixture {
            name: "coll_append_both_empty".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 5. coll_append_byte ──────────────────────────────────────────────────
    // Coll[Byte]([0x01, 0x02]) ++ Coll[Byte]([0x03]) → Coll[Byte]([0x01, 0x02, 0x03])
    // Uses NativeColl specialization in sigma-rust; our value_to_json unpacks bytes.
    {
        let lhs: Expr = Expr::Const(vec![1i8, 2i8].into());
        let rhs: Expr =
            Collection::new(SType::SByte, vec![Expr::Const(3i8.into())])?.into();
        let expr: Expr = Append::new(lhs, rhs)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollAppendFixture {
            name: "coll_append_byte".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 6. coll_append_cost_eq_lhs ───────────────────────────────────────────
    // [1..100] ++ [] — n1=100, n2=0, total=100.
    // Append cost (Pattern B-chunked): add_per_item_jit_cost(20, 2, 100, 100) = 20+2=22.
    // Entry 7 has the same n1+n2=100 total but opposite split; both must produce
    // identical `expected_cost` field (proves cost depends on n1+n2, not split).
    {
        let items: Vec<Expr> = (1i32..=100).map(|n| Expr::Const(n.into())).collect();
        let lhs: Expr = Collection::new(SType::SInt, items)?.into();
        let rhs: Expr = Collection::new(SType::SInt, vec![])?.into();
        let expr: Expr = Append::new(lhs, rhs)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollAppendFixture {
            name: "coll_append_cost_eq_lhs".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 7. coll_append_cost_eq_rhs ───────────────────────────────────────────
    // [] ++ [1..100] — n1=0, n2=100, total=100.
    // Append cost: add_per_item_jit_cost(20, 2, 100, 100) = 20+2=22.
    // Same total as entry 6; expected_cost must match entry 6 exactly.
    {
        let items: Vec<Expr> = (1i32..=100).map(|n| Expr::Const(n.into())).collect();
        let lhs: Expr = Collection::new(SType::SInt, vec![])?.into();
        let rhs: Expr = Collection::new(SType::SInt, items)?.into();
        let expr: Expr = Append::new(lhs, rhs)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollAppendFixture {
            name: "coll_append_cost_eq_rhs".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 8. coll_append_elem_tpe_mismatch ─────────────────────────────────────
    // Append(Coll[Int]([1,2]), Coll[Long]([3L])) → 'coll-elem-tpe-mismatch'
    //
    // `Append::new` rejects differing elem types at construction time.
    // We bypass by constructing `Append { input, col_2 }` directly (fields are pub).
    // The TS parser (permissive, no type-checking at wire layer) accepts the bytes.
    // The TS eval throws `'coll-elem-tpe-mismatch'` after both children eval
    // (Pattern B — cost for children is charged; the guard fires before the
    // Append-specific add_per_item_jit_cost call).
    //
    // We do NOT call sigma-rust try_eval_out — sigma-rust's evaluator would
    // return EvalError::UnexpectedValue; we only need bytes to test the TS guard.
    {
        let int_coll: Expr = Collection::new(
            SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())],
        )?
        .into();
        let long_coll: Expr = Collection::new(
            SType::SLong,
            vec![Expr::Const(3i64.into())],
        )?
        .into();
        // Bypass Append::new type check by constructing directly.
        let expr: Expr = Append {
            input: int_coll.into(),
            col_2: long_coll.into(),
        }
        .into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollAppendFixture {
            name: "coll_append_elem_tpe_mismatch".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-elem-tpe-mismatch"),
        });
    }

    // ── 9. coll_append_not_coll ──────────────────────────────────────────────
    // Append(Const(SInt, 42), Coll[Int]([])) → 'coll-input-not-coll'
    //
    // `Append::new` rejects non-Coll inputs. We bypass by constructing
    // `Append { input, col_2 }` directly. The TS parser accepts the bytes.
    // The TS eval throws `'coll-input-not-coll'` when `extractCollItems`
    // sees the Int SValue returned by the Const child.
    //
    // We do NOT call sigma-rust try_eval_out — same reason as entry 8.
    {
        let const_int: Expr = Expr::Const(42i32.into());
        let int_coll: Expr = Collection::new(SType::SInt, vec![])?.into();
        let expr: Expr = Append {
            input: const_int.into(),
            col_2: int_coll.into(),
        }
        .into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollAppendFixture {
            name: "coll_append_not_coll".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-input-not-coll"),
        });
    }

    Ok(CollAppendFixtureFile {
        corpus: "eval_coll_append",
        entries,
    })
}
