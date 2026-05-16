//! Phase 2f Coll HOFs Task 4 — ByIndex eval fixtures.
//!
//! Cost: `add_jit_cost(30)`. Pattern A (cost BEFORE child eval).
//! Sigma-rust ref: `ergotree-interpreter/src/eval/coll_by_index.rs:12-50`
//!   ctx.add_jit_cost(30)?;                      // line 18 — Pattern A, Fixed(30)
//!   let input_v = self.input.eval(env, ctx)?;   // line 19
//!   let index_v = self.index.eval(env, ctx)?;   // line 20
//!   match self.default {
//!     Some(default) => {
//!       let mut default_v = || default.eval(env, ctx);   // line 30 — LAZY closure
//!       val.map(Ok).unwrap_or_else(default_v)            // line 34 — only called on OOB
//!     }
//!     None => ... .ok_or_else(|| EvalError::Misc(...))   // line 40-47 — OOB throws
//!   }
//!
//! Fixture entries (10 total):
//!   1. coll_by_index_happy         — [10,20,30][1] → Int(20)
//!   2. coll_by_index_oob_no_def    — [1,2][5] → 'coll-by-index-out-of-range'
//!   3. coll_by_index_oob_with_def  — [1,2][5] orElse 99 → Int(99)
//!   4. coll_by_index_neg_no_def    — [1,2][-1] → 'coll-by-index-out-of-range'
//!   5. coll_by_index_neg_with_def  — [1,2][-1] orElse 99 → Int(99)
//!   6. coll_by_index_lazy_inbounds — [1,2,3][1] orElse (100 + 200) → Int(2), treeVersion=3, low cost
//!   7. coll_by_index_lazy_oob      — [1,2,3][5] orElse (100 + 200) → Int(300), treeVersion=3, high cost
//!      (Smoking-gun pair 6+7: treeVersion=3 enables lazy default; in-bounds cost < OOB cost)
//!   8. coll_by_index_cost_limit    — jitCostLimit=10 < Fixed(30) → 'cost-limit-exceeded'
//!   9. coll_by_index_idx_not_int   — ByIndex(Coll, Bool_const, null) → 'coll-by-index-index-not-int'
//!      (synthetic: raw bytes bypass ByIndex::new validation)
//!  10. coll_by_index_not_coll      — ByIndex(Const(SInt,42), int_idx, null) → 'coll-input-not-coll'
//!      (synthetic: raw bytes bypass ByIndex::new validation)
//!
//! Notes on entries 9+10 (synthetic):
//!   `ByIndex::new` rejects invalid type combos at construction time, and
//!   the `ByIndex` struct has a private `input_elem_tpe` field — we cannot
//!   bypass via direct struct construction. Instead we assemble raw ErgoTree
//!   bytes manually:
//!     [0x00 header] [0xb2 BY_INDEX opcode] [input_expr_bytes] [index_expr_bytes] [0x00 None]
//!   BY_INDEX opcode = LAST_CONSTANT_CODE(112) + new_op_code_shift(66) = 178 = 0xb2
//!   (sigma-rust op_code.rs line 105: `pub const BY_INDEX: OpCode = Self::new_op_code(66);`)
//!   The TS parser (permissive, no type-checking at wire layer) accepts these bytes.
//!   We do NOT call sigma-rust's evaluator for these entries.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_interpreter::eval::test_util::try_eval_out_with_version;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind};
use ergotree_ir::mir::coll_by_index::ByIndex;
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
pub struct CollByIndexFixture {
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
pub struct CollByIndexFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CollByIndexFixture>,
}

pub fn generate() -> anyhow::Result<CollByIndexFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. coll_by_index_happy ────────────────────────────────────────────────
    // [10, 20, 30][1] → Int(20)
    // Cost: Fixed(30) + ConcreteCollection(20 + 3*5=15) + index Const(5) = 70
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(10i32.into()),
                Expr::Const(20i32.into()),
                Expr::Const(30i32.into()),
            ],
        )?
        .into();
        let idx: Expr = Expr::Const(1i32.into());
        let expr: Expr = ByIndex::new(coll, idx, None)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        assert!(matches!(val, Value::Int(20)), "expected Int(20), got {:?}", val);

        entries.push(CollByIndexFixture {
            name: "coll_by_index_happy".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 2. coll_by_index_oob_no_def ──────────────────────────────────────────
    // [1, 2][5] with no default — OOB → sigma-rust EvalError::Misc
    // TS throws 'coll-by-index-out-of-range'.
    // We cannot call try_eval_out (sigma-rust would panic / error) — bytes only.
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())],
        )?
        .into();
        let idx: Expr = Expr::Const(5i32.into());
        let expr: Expr = ByIndex::new(coll, idx, None)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollByIndexFixture {
            name: "coll_by_index_oob_no_def".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-by-index-out-of-range"),
        });
    }

    // ── 3. coll_by_index_oob_with_def ────────────────────────────────────────
    // [1, 2][5] orElse 99 → Int(99)
    // OOB with default: sigma-rust returns the default value.
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())],
        )?
        .into();
        let idx: Expr = Expr::Const(5i32.into());
        let default: Expr = Expr::Const(99i32.into());
        let expr: Expr = ByIndex::new(coll, idx, Some(Box::new(default)))?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        assert!(matches!(val, Value::Int(99)), "expected Int(99), got {:?}", val);

        entries.push(CollByIndexFixture {
            name: "coll_by_index_oob_with_def".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 4. coll_by_index_neg_no_def ──────────────────────────────────────────
    // [1, 2][-1] with no default — negative index is OOB (i32 as usize wraps).
    // sigma-rust: `index_v.try_extract_into::<i32>()? as usize` → huge index → OOB.
    // TS throws 'coll-by-index-out-of-range'.
    // We cannot call try_eval_out (sigma-rust errors) — bytes only.
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())],
        )?
        .into();
        let idx: Expr = Expr::Const((-1i32).into());
        let expr: Expr = ByIndex::new(coll, idx, None)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollByIndexFixture {
            name: "coll_by_index_neg_no_def".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-by-index-out-of-range"),
        });
    }

    // ── 5. coll_by_index_neg_with_def ────────────────────────────────────────
    // [1, 2][-1] orElse 99 → Int(99)
    // Negative index is OOB; default is returned.
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())],
        )?
        .into();
        let idx: Expr = Expr::Const((-1i32).into());
        let default: Expr = Expr::Const(99i32.into());
        let expr: Expr = ByIndex::new(coll, idx, Some(Box::new(default)))?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        assert!(matches!(val, Value::Int(99)), "expected Int(99), got {:?}", val);

        entries.push(CollByIndexFixture {
            name: "coll_by_index_neg_with_def".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 6. coll_by_index_lazy_inbounds ───────────────────────────────────────
    // Smoking-gun pair A: [1,2,3][1] orElse (100 + 200), treeVersion=3
    // Index 1 is IN-BOUNDS. With treeVersion=3 sigma-rust uses
    // `val.map(Ok).unwrap_or_else(default_v)` — lazy: default NOT evaluated.
    // (V0 would use `val.unwrap_or(default_v()?)` — eager, always charges default.)
    // Expected: Int(2). Cost is lower than entry 7.
    //
    // Default: BinOp(Add, 100i32, 200i32) — evaluates to Int(300) when needed.
    // Same type (SInt) as the collection element, satisfying ByIndex::new.
    // Additional cost when evaluated: BinOp(9) + Const(5) + Const(5) = 19.
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(1i32.into()),
                Expr::Const(2i32.into()),
                Expr::Const(3i32.into()),
            ],
        )?
        .into();
        let idx: Expr = Expr::Const(1i32.into());
        // Default: 100 + 200 → Int(300). Satisfies ByIndex::new (SInt elem type).
        let default: Expr = BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::Const(100i32.into())),
            right: Box::new(Expr::Const(200i32.into())),
        }
        .into();
        let expr: Expr = ByIndex::new(coll, idx, Some(Box::new(default)))?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        // Use treeVersion=3 to activate lazy default eval.
        // activated_version=3 → pre_header.version=4 (try_eval_out_with_version API).
        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out_with_version(&tree.proposition()?, &ctx, 3, 3)?;
        assert!(matches!(val, Value::Int(2)), "expected Int(2), got {:?}", val);

        // Capture cost using a fresh context at tree_version=3.
        let mut cost_ctx = ctx.clone();
        cost_ctx.pre_header.version = 4; // activated_version=3 → block version=4
        cost_ctx.tree_version.set(3u8.into());
        let _: Value<'static> = try_eval_out(&tree.proposition()?, &cost_ctx)?;

        entries.push(CollByIndexFixture {
            name: "coll_by_index_lazy_inbounds".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "treeVersion": 3 }),
            expected_value_json: value_to_json(&val),
            expected_cost: cost_ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 7. coll_by_index_lazy_oob ─────────────────────────────────────────────
    // Smoking-gun pair B: [1,2,3][5] orElse (100 + 200), treeVersion=3
    // Index 5 is OOB → default IS evaluated (lazy: called by unwrap_or_else).
    // Expected: Int(300). Cost is HIGHER than entry 6 (BinOp + 2×Const charged).
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(1i32.into()),
                Expr::Const(2i32.into()),
                Expr::Const(3i32.into()),
            ],
        )?
        .into();
        let idx: Expr = Expr::Const(5i32.into());
        let default: Expr = BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::Const(100i32.into())),
            right: Box::new(Expr::Const(200i32.into())),
        }
        .into();
        let expr: Expr = ByIndex::new(coll, idx, Some(Box::new(default)))?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out_with_version(&tree.proposition()?, &ctx, 3, 3)?;
        assert!(matches!(val, Value::Int(300)), "expected Int(300), got {:?}", val);

        let mut cost_ctx = ctx.clone();
        cost_ctx.pre_header.version = 4;
        cost_ctx.tree_version.set(3u8.into());
        let _: Value<'static> = try_eval_out(&tree.proposition()?, &cost_ctx)?;

        entries.push(CollByIndexFixture {
            name: "coll_by_index_lazy_oob".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "treeVersion": 3 }),
            expected_value_json: value_to_json(&val),
            expected_cost: cost_ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 8. coll_by_index_cost_limit ──────────────────────────────────────────
    // jitCostLimit=10 < Fixed(30) → 'cost-limit-exceeded'
    // Pattern A: addCost(30) fires BEFORE eval-children. Same tree as entry 1.
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(10i32.into()),
                Expr::Const(20i32.into()),
                Expr::Const(30i32.into()),
            ],
        )?
        .into();
        let idx: Expr = Expr::Const(1i32.into());
        let expr: Expr = ByIndex::new(coll, idx, None)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(CollByIndexFixture {
            name: "coll_by_index_cost_limit".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "jitCostLimit": 10 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("cost-limit-exceeded"),
        });
    }

    // ── 9. coll_by_index_idx_not_int ─────────────────────────────────────────
    // ByIndex(Coll[Int]([1,2,3]), Const(SBoolean, true), None)
    // index evaluates to Boolean, not Int → 'coll-by-index-index-not-int'.
    //
    // `ByIndex::new` rejects non-SInt index at construction time (line 45-50 of
    // ergotree-ir/src/mir/coll_by_index.rs). The struct also has a private
    // `input_elem_tpe` field so we cannot bypass via direct struct literal.
    //
    // Strategy: build raw bytes manually.
    //   [0x00]  = ErgoTree v0 header, no constant segregation
    //   [0xb2]  = BY_INDEX opcode (LAST_CONSTANT_CODE=112 + shift=66 = 178 = 0xb2)
    //   [coll_expr_bytes]   = serialized Coll[Int]([1,2,3]) expression
    //   [bool_idx_bytes]    = serialized Const(SBoolean, true) expression
    //   [0x00]              = None option (no default)
    //
    // We do NOT call sigma-rust try_eval_out — sigma-rust would reject.
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![
                Expr::Const(1i32.into()),
                Expr::Const(2i32.into()),
                Expr::Const(3i32.into()),
            ],
        )?
        .into();
        let bool_idx: Expr = Expr::Const(true.into());

        let coll_bytes = coll.sigma_serialize_bytes()?;
        let idx_bytes = bool_idx.sigma_serialize_bytes()?;

        // Assemble raw ErgoTree bytes:
        // [header=0x00][opcode=0xb2][coll_expr][bool_idx_expr][option=0x00]
        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8); // ErgoTreeHeader v0(false) → serialized = 0x00
        tree_bytes.push(0xb2u8); // BY_INDEX opcode
        tree_bytes.extend_from_slice(&coll_bytes);
        tree_bytes.extend_from_slice(&idx_bytes);
        tree_bytes.push(0x00u8); // Option::None

        entries.push(CollByIndexFixture {
            name: "coll_by_index_idx_not_int".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-by-index-index-not-int"),
        });
    }

    // ── 10. coll_by_index_not_coll ────────────────────────────────────────────
    // ByIndex(Const(SInt, 42), Const(SInt, 0), None)
    // input evaluates to Int, not Coll → 'coll-input-not-coll'.
    //
    // Same strategy as entry 9: raw bytes bypass ByIndex::new validation.
    // [0x00][0xb2][int_const_bytes][int_idx_bytes][0x00]
    //
    // We do NOT call sigma-rust try_eval_out.
    {
        let const_int: Expr = Expr::Const(42i32.into());
        let int_idx: Expr = Expr::Const(0i32.into());

        let const_bytes = const_int.sigma_serialize_bytes()?;
        let idx_bytes = int_idx.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8); // header
        tree_bytes.push(0xb2u8); // BY_INDEX opcode
        tree_bytes.extend_from_slice(&const_bytes);
        tree_bytes.extend_from_slice(&idx_bytes);
        tree_bytes.push(0x00u8); // Option::None

        entries.push(CollByIndexFixture {
            name: "coll_by_index_not_coll".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-input-not-coll"),
        });
    }

    Ok(CollByIndexFixtureFile {
        corpus: "eval_coll_by_index",
        entries,
    })
}
