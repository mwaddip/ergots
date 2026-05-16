//! Phase 2f Coll HOFs Task 5 — Slice eval fixtures.
//!
//! Cost: `add_per_item_jit_cost(10, 2, 100, n_items)` where
//! `n_items = max(0, until - from)`. Pattern B-chunked (cost AFTER all child evals).
//! **Cost scales with the REQUESTED RANGE, not input length or clipped output.**
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/coll_slice.rs:17-43`
//!   let input_v = self.input.eval(env, ctx)?;      // line 17
//!   let from_v = self.from.eval(env, ctx)?;        // line 18
//!   let until_v = self.until.eval(env, ctx)?;      // line 19
//!   ...
//!   let n_items = 0i32.max(until - from) as u32;  // line 31
//!   ctx.add_per_item_jit_cost(10, 2, 100, n_items)?;  // line 32 — Pattern B-chunked
//!   // intersection with collection bounds (github.com/ergoplatform/sigma-rust/issues/724)
//!   let range = from.max(0) as usize..until.min(input_vec.len() as i32) as usize;
//!
//! Bug-7 regression: `add_per_item_jit_cost(10, 2, 100, n_items)` uses requested range,
//! NOT input length. See sigma-rust issue #724 and coll_slice.rs:161-212.
//!
//! Fixture entries (10 total):
//!   1. coll_slice_happy           — [1,2,3,4][1..3] → [2,3]
//!   2. coll_slice_neg_from        — [1,2,3,4][-1..3] → [1,2,3] (clipped, no throw)
//!   3. coll_slice_until_oob       — [1,2,3,4][2..10] → [3,4] (clipped, no throw)
//!   4. coll_slice_from_ge_until   — [1,2,3,4][3..1] → [] (n_items=0)
//!   5. coll_slice_empty_input     — [][1..3] → [] (empty input)
//!   6. coll_slice_smoking_gun_5   — [0..5][0..2] → [0,1] (smoking-gun A: small input)
//!   7. coll_slice_smoking_gun_1k  — [0..1000][0..2] → [0,1] (smoking-gun B: large input)
//!      (Entries 6+7: identical expected_cost — proves cost depends on requested range, not input len)
//!   8. coll_slice_large_range     — [0..5][0..200] → [0,1,2,3,4]; cost reflects range=200
//!      (cost > entries 6+7 — proves cost scales with requested range)
//!   9. coll_slice_bound_not_int   — Slice(Coll, Bool_from, Int_until) → 'coll-slice-bound-not-int'
//!      (synthetic: raw bytes bypass Slice::new validation)
//!  10. coll_slice_not_coll        — Slice(Const(SInt,42), Int_from, Int_until) → 'coll-input-not-coll'
//!      (synthetic: raw bytes bypass Slice::new validation)
//!
//! Notes on entries 9+10 (synthetic):
//!   `Slice::new` rejects invalid type combos at construction time. We assemble
//!   raw ErgoTree bytes manually — same strategy as coll_by_index.rs entries 9+10.
//!     [0x00 header] [0xb4 SLICE opcode] [input_expr][from_expr][until_expr]
//!   SLICE opcode = LAST_CONSTANT_CODE(112) + new_op_code(68) = 180 = 0xb4
//!   (sigma-rust op_code.rs line 107: `pub const SLICE: OpCode = Self::new_op_code(68);`)
//!   We do NOT call sigma-rust try_eval_out for these entries.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::coll_slice::Slice;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct CollSliceFixture {
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
pub struct CollSliceFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CollSliceFixture>,
}

pub fn generate() -> anyhow::Result<CollSliceFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. coll_slice_happy ───────────────────────────────────────────────────
    // [1,2,3,4][1..3] → [2,3]
    // n_items = max(0, 3-1) = 2. Intersection: from.max(0)=1..until.min(4)=3.
    {
        let coll: Expr = Expr::Const(vec![1i64, 2i64, 3i64, 4i64].into());
        let from: Expr = Expr::Const(1i32.into());
        let until: Expr = Expr::Const(3i32.into());
        let expr: Expr = Slice::new(coll, from, until)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollSliceFixture {
            name: "coll_slice_happy".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 2. coll_slice_neg_from ────────────────────────────────────────────────
    // [1,2,3,4][-1..3] → [1,2,3] (clipped, no throw — Scala semantics)
    // n_items = max(0, 3-(-1)) = 4. Intersection: from.max(0)=0..until.min(4)=3.
    // sigma-rust issue #724: does NOT throw on OOB; clips to valid range.
    {
        let coll: Expr = Expr::Const(vec![1i64, 2i64, 3i64, 4i64].into());
        let from: Expr = Expr::Const((-1i32).into());
        let until: Expr = Expr::Const(3i32.into());
        let expr: Expr = Slice::new(coll, from, until)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollSliceFixture {
            name: "coll_slice_neg_from".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 3. coll_slice_until_oob ───────────────────────────────────────────────
    // [1,2,3,4][2..10] → [3,4] (clipped, no throw)
    // n_items = max(0, 10-2) = 8. Intersection: from.max(0)=2..until.min(4)=4.
    {
        let coll: Expr = Expr::Const(vec![1i64, 2i64, 3i64, 4i64].into());
        let from: Expr = Expr::Const(2i32.into());
        let until: Expr = Expr::Const(10i32.into());
        let expr: Expr = Slice::new(coll, from, until)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollSliceFixture {
            name: "coll_slice_until_oob".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 4. coll_slice_from_ge_until ───────────────────────────────────────────
    // [1,2,3,4][3..1] → [] (from >= until → n_items = max(0, 1-3) = 0)
    // Intersection: from.max(0)=3..until.min(4)=1 → empty (3 >= 1).
    {
        let coll: Expr = Expr::Const(vec![1i64, 2i64, 3i64, 4i64].into());
        let from: Expr = Expr::Const(3i32.into());
        let until: Expr = Expr::Const(1i32.into());
        let expr: Expr = Slice::new(coll, from, until)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollSliceFixture {
            name: "coll_slice_from_ge_until".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 5. coll_slice_empty_input ─────────────────────────────────────────────
    // [][1..3] → []
    // n_items = max(0, 3-1) = 2. Intersection: 0..0 on empty input → empty.
    {
        let coll: Expr = Expr::Const(Vec::<i64>::new().into());
        let from: Expr = Expr::Const(1i32.into());
        let until: Expr = Expr::Const(3i32.into());
        let expr: Expr = Slice::new(coll, from, until)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollSliceFixture {
            name: "coll_slice_empty_input".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 6. coll_slice_smoking_gun_5 ───────────────────────────────────────────
    // [0..5][0..2] → [0,1]
    // n_items = max(0, 2-0) = 2. Small input (5 items).
    // This entry and entry 7 MUST have identical expected_cost — proves cost
    // depends on (until - from), NOT input length (sigma-rust issue #724 fix).
    // See coll_slice.rs:167-211 regression test.
    {
        let items: Vec<i64> = (0i64..5).collect();
        let coll: Expr = Expr::Const(items.into());
        let from: Expr = Expr::Const(0i32.into());
        let until: Expr = Expr::Const(2i32.into());
        let expr: Expr = Slice::new(coll, from, until)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollSliceFixture {
            name: "coll_slice_smoking_gun_5".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 7. coll_slice_smoking_gun_1k ──────────────────────────────────────────
    // [0..1000][0..2] → [0,1]
    // n_items = max(0, 2-0) = 2. Large input (1000 items).
    // expected_cost MUST equal entry 6 — same requested range, different input size.
    {
        let items: Vec<i64> = (0i64..1000).collect();
        let coll: Expr = Expr::Const(items.into());
        let from: Expr = Expr::Const(0i32.into());
        let until: Expr = Expr::Const(2i32.into());
        let expr: Expr = Slice::new(coll, from, until)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollSliceFixture {
            name: "coll_slice_smoking_gun_1k".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 8. coll_slice_large_range ─────────────────────────────────────────────
    // [0..5][0..200] → [0,1,2,3,4] (output clipped to 5 items)
    // n_items = max(0, 200-0) = 200. add_per_item_jit_cost(10, 2, 100, 200).
    // Cost reflects requested range=200, NOT clipped output length=5.
    // Cost MUST be greater than entries 6+7 (which have n_items=2).
    {
        let items: Vec<i64> = (0i64..5).collect();
        let coll: Expr = Expr::Const(items.into());
        let from: Expr = Expr::Const(0i32.into());
        let until: Expr = Expr::Const(200i32.into());
        let expr: Expr = Slice::new(coll, from, until)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(CollSliceFixture {
            name: "coll_slice_large_range".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 9. coll_slice_bound_not_int ───────────────────────────────────────────
    // Slice(Coll[Long]([1,2,3]), Const(SBoolean, true), Const(SInt, 3))
    // from evaluates to Boolean → 'coll-slice-bound-not-int'
    //
    // `Slice::new` rejects non-SInt from/until at construction time. We bypass
    // by building raw ErgoTree bytes manually.
    //   [0x00]  = ErgoTree v0 header, no constant segregation
    //   [0xb4]  = SLICE opcode (LAST_CONSTANT_CODE=112 + new_op_code(68) = 180 = 0xb4)
    //   [coll_expr_bytes]   = serialized Const(SColl[SLong], [1,2,3])
    //   [bool_from_bytes]   = serialized Const(SBoolean, true)
    //   [int_until_bytes]   = serialized Const(SInt, 3)
    //
    // We do NOT call sigma-rust try_eval_out.
    {
        let coll: Expr = Expr::Const(vec![1i64, 2i64, 3i64].into());
        let bool_from: Expr = Expr::Const(true.into());
        let int_until: Expr = Expr::Const(3i32.into());

        let coll_bytes = coll.sigma_serialize_bytes()?;
        let from_bytes = bool_from.sigma_serialize_bytes()?;
        let until_bytes = int_until.sigma_serialize_bytes()?;

        // Assemble raw ErgoTree bytes:
        // [header=0x00][opcode=0xb4][coll_expr][bool_from_expr][int_until_expr]
        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8); // ErgoTreeHeader v0(false) → serialized = 0x00
        tree_bytes.push(0xb4u8); // SLICE opcode
        tree_bytes.extend_from_slice(&coll_bytes);
        tree_bytes.extend_from_slice(&from_bytes);
        tree_bytes.extend_from_slice(&until_bytes);

        entries.push(CollSliceFixture {
            name: "coll_slice_bound_not_int".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-slice-bound-not-int"),
        });
    }

    // ── 10. coll_slice_not_coll ───────────────────────────────────────────────
    // Slice(Const(SInt, 42), Const(SInt, 0), Const(SInt, 3))
    // input evaluates to Int, not Coll → 'coll-input-not-coll'
    //
    // Same strategy: raw bytes bypass Slice::new validation.
    // [0x00][0xb4][int_const_bytes][int_from_bytes][int_until_bytes]
    //
    // We do NOT call sigma-rust try_eval_out.
    {
        let const_int: Expr = Expr::Const(42i32.into());
        let int_from: Expr = Expr::Const(0i32.into());
        let int_until: Expr = Expr::Const(3i32.into());

        let const_bytes = const_int.sigma_serialize_bytes()?;
        let from_bytes = int_from.sigma_serialize_bytes()?;
        let until_bytes = int_until.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8); // header
        tree_bytes.push(0xb4u8); // SLICE opcode
        tree_bytes.extend_from_slice(&const_bytes);
        tree_bytes.extend_from_slice(&from_bytes);
        tree_bytes.extend_from_slice(&until_bytes);

        entries.push(CollSliceFixture {
            name: "coll_slice_not_coll".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-input-not-coll"),
        });
    }

    Ok(CollSliceFixtureFile {
        corpus: "eval_coll_slice",
        entries,
    })
}
