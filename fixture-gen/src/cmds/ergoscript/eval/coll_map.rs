//! Phase 2f Coll HOFs Task 6 — Map eval fixtures (first lambda HOF).
//!
//! Cost: Mixed pattern.
//!   - Outer (after input/mapper eval, before loop):
//!       `ctx.add_per_item_jit_cost(20, 1, 10, n)` where n = input.len()
//!   - Per-iter (inside closure, before body eval):
//!       `ctx.add_jit_cost(5)` per element
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/coll_map.rs:14-84`
//!   line 20: let input_v = self.input.eval(env, ctx)?;
//!   line 21: let mapper_v = self.mapper.eval(env, ctx)?;
//!   line 31: ctx.add_jit_cost(5)?;           // per-iter cost inside closure
//!   line 46-55: mapper_sfunc.t_dom.first() — input elem type check
//!   line 58: if *coll.elem_tpe() != mapper_input_tpe → EvalError
//!   line 72: ctx.add_per_item_jit_cost(20, 1, 10, n)?; // outer cost
//!   line 73-82: map over items, collect result Coll
//!
//! Outer cost formula: `add_per_item_jit_cost(base=20, per_chunk=1, chunk_size=10, n)`:
//!   cost = base + per_chunk * ceil(n / chunk_size)
//!   For n=0:  20 + 1 * ceil(0/10)  = 20 + 0 = 20
//!   For n=4:  20 + 1 * ceil(4/10)  = 20 + 1 = 21
//!   For n=5:  20 + 1 * ceil(5/10)  = 20 + 1 = 21
//!   For n=12: 20 + 1 * ceil(12/10) = 20 + 2 = 22
//!
//! Total arm contribution = outer + sum(per-iter):
//!   n=0:  20 + 5*0  = 20
//!   n=4:  21 + 5*4  = 41
//!   n=5:  21 + 5*5  = 46
//!   n=12: 22 + 5*12 = 82
//!
//! (Costs above are the arm-only contributions; sigma-rust's try_eval_out
//!  includes FuncValue(5) + other fixed costs from child exprs too.)
//!
//! Fixture entries (8 real + cost-limit):
//!   1. coll_map_happy        — [1,2,3,4].map(x => x + 1) → [2,3,4,5]
//!   2. coll_map_empty        — [].map(x => x + 1)        → []  (outer cost only, n=0)
//!   3. coll_map_sg_n5        — [0..5].map(x => x)        → [0..5]  (n=5, outer=21)
//!   4. coll_map_sg_n12       — [0..12].map(x => x)       → [0..12] (n=12, outer=22)
//!      (entries 3+4 prove outer cost changes: n=5 → 21, n=12 → 22)
//!   5. coll_map_not_coll     — Map(Const(SInt,42), mapper) → 'coll-input-not-coll'
//!      (synthetic: Map::new validates, so raw bytes needed)
//!   6. coll_map_cost_limit   — jitCostLimit too low → 'cost-limit-exceeded'
//!
//! Entries 5 uses raw bytes to bypass Map::new type validation.
//! MAP opcode = LAST_CONSTANT_CODE(112) + new_op_code(61) = 173 = 0xAD

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind};
use ergotree_ir::mir::coll_map::Map;
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
pub struct CollMapFixture {
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
pub struct CollMapFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CollMapFixture>,
}

/// Build a Map expr: `input.map(x => body)` where `x` is bound to `ValId(1)`.
/// `x_tpe` is the element type of `input` (= arg type of mapper).
fn build_map(input: Expr, x_tpe: SType, body: Expr) -> anyhow::Result<Expr> {
    let mapper: Expr = FuncValue::new(
        vec![FuncArg { idx: ValId(1), tpe: x_tpe }],
        body,
    )
    .into();
    Ok(Map::new(input, mapper)?.into())
}

fn build_tree(expr: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, expr: Expr) -> anyhow::Result<CollMapFixture> {
    let (tree, hex) = build_tree(expr)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(CollMapFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn cost_limit_entry(name: &str, expr: Expr, limit: u64) -> anyhow::Result<CollMapFixture> {
    let (_tree, hex) = build_tree(expr)?;
    Ok(CollMapFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<CollMapFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. coll_map_happy ─────────────────────────────────────────────────────
    // [1,2,3,4].map(x => x + 1) → [2,3,4,5]
    // x: SInt; body = x + 1 (BinOp Plus)
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32, 4i32].into());
        let body: Expr = BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
            right: Box::new(Expr::Const(1i32.into())),
        }
        .into();
        let expr = build_map(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_map_happy", expr)?);
    }

    // ── 2. coll_map_empty ────────────────────────────────────────────────────
    // [].map(x => x + 1) → []
    // Empty collection — outer cost only (n=0 → outer=20), zero per-iter.
    {
        let coll: Expr = Expr::Const(Vec::<i32>::new().into());
        let body: Expr = BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt })),
            right: Box::new(Expr::Const(1i32.into())),
        }
        .into();
        let expr = build_map(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_map_empty", expr)?);
    }

    // ── 3. coll_map_sg_n5 ────────────────────────────────────────────────────
    // [0..5].map(x => x) → [0,1,2,3,4]  (identity; n=5)
    // Smoking-gun A: n=5, outer=ceil(5/10)*1 + 20 = 21.
    // Per-iter = 5 * 5 = 25. Arm contribution = 21 + 25 = 46 (+ other expr costs).
    {
        let items: Vec<i32> = (0i32..5).collect();
        let coll: Expr = Expr::Const(items.into());
        // Identity: body = ValUse(1, SInt)
        let body: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt });
        let expr = build_map(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_map_sg_n5", expr)?);
    }

    // ── 4. coll_map_sg_n12 ───────────────────────────────────────────────────
    // [0..12].map(x => x) → [0,1,...,11]  (identity; n=12)
    // Smoking-gun B: n=12, outer=ceil(12/10)*1 + 20 = 22.
    // Per-iter = 12 * 5 = 60. Arm contribution = 22 + 60 = 82 (+ other expr costs).
    // Compare with entry 3: outer cost differs (21 vs 22) — proves chunked outer cost.
    {
        let items: Vec<i32> = (0i32..12).collect();
        let coll: Expr = Expr::Const(items.into());
        let body: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt });
        let expr = build_map(coll, SType::SInt, body)?;
        entries.push(success_entry("coll_map_sg_n12", expr)?);
    }

    // ── 5. coll_map_not_coll ─────────────────────────────────────────────────
    // Map(Const(SInt, 42), mapper_for_Int) → 'coll-input-not-coll'
    //
    // `Map::new` validates that input is SColl — so we must bypass via raw bytes.
    // MAP opcode = LAST_CONSTANT_CODE(112) + new_op_code(61) = 173 = 0xAD
    //
    // Assemble raw ErgoTree:
    //   [0x00]  header
    //   [0xAD]  MAP opcode
    //   [int_const_bytes]   Const(SInt, 42)
    //   [mapper_bytes]      FuncValue((x: SInt) => x)
    //
    // We do NOT call sigma-rust try_eval_out for this entry (it would panic).
    {
        let int_const: Expr = Expr::Const(42i32.into());
        // Build a valid FuncValue expr as the mapper (type doesn't matter since
        // the eval will fail at the input-not-coll check first).
        let mapper: Expr = FuncValue::new(
            vec![FuncArg { idx: ValId(1), tpe: SType::SInt }],
            Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt }),
        )
        .into();

        let const_bytes = int_const.sigma_serialize_bytes()?;
        let mapper_bytes = mapper.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8); // ErgoTreeHeader v0(false) → 0x00
        tree_bytes.push(0xADu8); // MAP opcode = 112 + 61 = 173 = 0xAD
        tree_bytes.extend_from_slice(&const_bytes);
        tree_bytes.extend_from_slice(&mapper_bytes);

        entries.push(CollMapFixture {
            name: "coll_map_not_coll".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-input-not-coll"),
        });
    }

    // ── 6. coll_map_cost_limit ───────────────────────────────────────────────
    // jitCostLimit too low → cost-limit-exceeded before eval completes.
    // Use [1,2,3].map(x => x + 1). The FuncValue eval charges 5, plus Const
    // charges accumulate — any limit < the total will trigger the error.
    // Limit = 1 guarantees the very first charge (Const or FuncValue) overflows.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let body: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: SType::SInt });
        let expr = build_map(coll, SType::SInt, body)?;
        entries.push(cost_limit_entry("coll_map_cost_limit", expr, 1)?);
    }

    Ok(CollMapFixtureFile {
        corpus: "eval_coll_map",
        entries,
    })
}
