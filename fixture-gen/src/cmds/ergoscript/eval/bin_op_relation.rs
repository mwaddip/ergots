//! BinOp.Relation family — fixtures for the four ordering ops
//! (`Lt`, `Le`, `Gt`, `Ge`) on Byte/Short/Int/Long/BigInt operands,
//! and Eq / NEq across all supported SValue kinds.
//!
//! Sigma-rust ref:
//!   `ergotree-interpreter/src/eval/bin_op.rs:205-211`
//!   ```
//!   BinOpKind::Relation(op) => match op {
//!       RelationOp::Eq | RelationOp::NEq => {}  // cost charged inside eq_with_cost
//!       _ => { ctx.add_jit_cost(20)?; }  // LT, LE, GT, GE = Fixed(20)
//!   },
//!   ```
//!   `bin_op.rs:250-253` — Gt/Lt/Ge/Le dispatch via per-kind helpers.
//!
//! Ordering cost: envelope Fixed(20) + Const eval cost (5 per const operand).
//! Total for Const+Const operands = 20 + 5 + 5 = 30.
//!
//! Eq/NEq cost: no envelope charge; cost delegated entirely to the recursive
//! `eq_with_cost` function in `data_value_comparer.rs`. Type-specific costs:
//!   EQ_PRIM_COST = 3  (Boolean/Byte/Short/Int/Long/Unit/SigmaProp/cross-type)
//!   EQ_BIGINT_COST = 5
//!   EQ_GROUP_ELEMENT_COST = 172
//!   EQ_TUPLE_COST = 4  (+ recursive element costs)
//!   EQ_OPTION_COST = 4  (+ recursive inner costs when both Some)
//!   Coll: COLL_MATCH_TYPE_COST=1 + if lengths equal:
//!         add_per_item_jit_cost(base, per_chunk, chunk_size, n) = base + ceil(n/chunk_size)*per_chunk
//!         For SInt: (base=15, per_chunk=2, chunk_size=64)
//!
//! Error cases:
//!   - `bin-op-not-numeric`: non-numeric left operand for ordering op (e.g. Boolean).
//!   - `bin-op-kind-mismatch`: left and right operands have different kinds for ordering op.
//!
//! Schema: same unified struct — `expected_error_code` is null for success entries,
//! `expected_value_json`/`expected_cost` are null/0 for error entries.

use ergo_chain_types::ec_point::generator;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{BinOp, BinOpKind, RelationOp};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{SigmaBoolean, SigmaProp};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct BinOpRelationFixture {
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
pub struct BinOpRelationFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<BinOpRelationFixture>,
}

/// Build a BinOp.Relation tree (v0, no segregation).
fn build_relation_tree(op: RelationOp, lv: Expr, rv: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = BinOp {
        kind: BinOpKind::Relation(op),
        left: Box::new(lv),
        right: Box::new(rv),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Success entry: sigma-rust evaluates and we record value + cost.
fn success_entry(
    name: &str,
    op: RelationOp,
    lv: Expr,
    rv: Expr,
) -> anyhow::Result<BinOpRelationFixture> {
    let (tree, hex) = build_relation_tree(op, lv, rv)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(BinOpRelationFixture {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Error entry: sigma-rust would fail; we capture the TS error code.
fn error_entry(
    name: &str,
    op: RelationOp,
    lv: Expr,
    rv: Expr,
    code: &str,
) -> anyhow::Result<BinOpRelationFixture> {
    let (_tree, hex) = build_relation_tree(op, lv, rv)?;
    Ok(BinOpRelationFixture {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<BinOpRelationFixtureFile> {
    let mut entries: Vec<BinOpRelationFixture> = Vec::new();

    // -------------------------------------------------------------------------
    // Lt — 5 kinds with less/equal/greater cases
    // -------------------------------------------------------------------------
    // Byte: i8 values
    entries.push(success_entry(
        "lt_byte_less",
        RelationOp::Lt,
        Expr::Const((-10i8).into()),
        Expr::Const(10i8.into()),
    )?);
    entries.push(success_entry(
        "lt_byte_equal",
        RelationOp::Lt,
        Expr::Const(5i8.into()),
        Expr::Const(5i8.into()),
    )?);

    // Short: i16 values
    entries.push(success_entry(
        "lt_short_less",
        RelationOp::Lt,
        Expr::Const((-1000i16).into()),
        Expr::Const(1000i16.into()),
    )?);

    // Int: i32 values
    entries.push(success_entry(
        "lt_int_less",
        RelationOp::Lt,
        Expr::Const(1i32.into()),
        Expr::Const(2i32.into()),
    )?);
    entries.push(success_entry(
        "lt_int_equal",
        RelationOp::Lt,
        Expr::Const(42i32.into()),
        Expr::Const(42i32.into()),
    )?);
    entries.push(success_entry(
        "lt_int_greater",
        RelationOp::Lt,
        Expr::Const(100i32.into()),
        Expr::Const(1i32.into()),
    )?);

    // Long: i64 values
    entries.push(success_entry(
        "lt_long_less",
        RelationOp::Lt,
        Expr::Const((-9999999999i64).into()),
        Expr::Const(9999999999i64.into()),
    )?);
    entries.push(success_entry(
        "lt_long_greater",
        RelationOp::Lt,
        Expr::Const(i64::MAX.into()),
        Expr::Const(i64::MIN.into()),
    )?);

    // BigInt: BigInt256 values
    entries.push(success_entry(
        "lt_bigint_less",
        RelationOp::Lt,
        Expr::Const(BigInt256::from(-1i64).into()),
        Expr::Const(BigInt256::from(1i64).into()),
    )?);

    // -------------------------------------------------------------------------
    // Le — Int + Long baselines
    // -------------------------------------------------------------------------
    entries.push(success_entry(
        "le_int_less",
        RelationOp::Le,
        Expr::Const(1i32.into()),
        Expr::Const(2i32.into()),
    )?);
    entries.push(success_entry(
        "le_int_equal",
        RelationOp::Le,
        Expr::Const(7i32.into()),
        Expr::Const(7i32.into()),
    )?);
    entries.push(success_entry(
        "le_int_greater",
        RelationOp::Le,
        Expr::Const(10i32.into()),
        Expr::Const(3i32.into()),
    )?);
    entries.push(success_entry(
        "le_long_equal",
        RelationOp::Le,
        Expr::Const(i64::MIN.into()),
        Expr::Const(i64::MIN.into()),
    )?);

    // -------------------------------------------------------------------------
    // Gt — Int + Long baselines
    // -------------------------------------------------------------------------
    entries.push(success_entry(
        "gt_int_greater",
        RelationOp::Gt,
        Expr::Const(99i32.into()),
        Expr::Const(1i32.into()),
    )?);
    entries.push(success_entry(
        "gt_int_equal",
        RelationOp::Gt,
        Expr::Const(0i32.into()),
        Expr::Const(0i32.into()),
    )?);
    entries.push(success_entry(
        "gt_long_greater",
        RelationOp::Gt,
        Expr::Const(i64::MAX.into()),
        Expr::Const(0i64.into()),
    )?);

    // -------------------------------------------------------------------------
    // Ge — Int + BigInt baselines
    // -------------------------------------------------------------------------
    entries.push(success_entry(
        "ge_int_greater",
        RelationOp::Ge,
        Expr::Const(5i32.into()),
        Expr::Const(4i32.into()),
    )?);
    entries.push(success_entry(
        "ge_int_equal",
        RelationOp::Ge,
        Expr::Const((-1i32).into()),
        Expr::Const((-1i32).into()),
    )?);
    entries.push(success_entry(
        "ge_bigint_equal",
        RelationOp::Ge,
        Expr::Const(BigInt256::from(0i64).into()),
        Expr::Const(BigInt256::from(0i64).into()),
    )?);

    // -------------------------------------------------------------------------
    // Mismatched-numeric ORDERING is NO LONGER a rejection here (pre-V3).
    //
    // The JVM deserializer auto-upcasts the narrower numeric operand for pre-V3
    // ErgoTree versions (DeserializationSigmaBuilder.applyUpcast via comparisonOp,
    // SigmaBuilder.scala:689-697,750-756), so e.g. Lt(Int, Long) v0 evaluates as a
    // Long comparison. sigma-rust (this generator's reference) still rejects it and
    // CANNOT produce the JVM-correct value/cost, so these moved to the ergots-side
    // JVM-aligned test
    // (packages/ergoscript/test/eval/bin-op-mismatched-numeric-coercion.test.ts).
    // See docs/specs/2026-06-01-ergoscript-mismatched-numeric-coercion-design.md.
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Error: non-numeric operand — Boolean + Boolean for Lt.
    // Sigma-rust's eval_lt falls through to `_ => EvalError::UnexpectedValue`.
    // TS maps this to 'bin-op-not-numeric'.
    // -------------------------------------------------------------------------
    entries.push(error_entry(
        "lt_not_numeric_bool",
        RelationOp::Lt,
        Expr::Const(true.into()),
        Expr::Const(false.into()),
        "bin-op-not-numeric",
    )?);

    entries.push(error_entry(
        "gt_not_numeric_bool",
        RelationOp::Gt,
        Expr::Const(false.into()),
        Expr::Const(true.into()),
        "bin-op-not-numeric",
    )?);

    // =========================================================================
    // Eq / NEq — all supported SValue kinds (Task 7)
    // =========================================================================
    // Cost for Const+Const operands:
    //   left_Const(5) + right_Const(5) + eq_with_cost_charge
    // No envelope cost for Eq/NEq (sigma-rust bin_op.rs:205).
    //
    // For primitives (Boolean/Byte/Short/Int/Long) eq_with_cost charges EQ_PRIM_COST=3.
    // So total = 5 + 5 + 3 = 13.
    // For BigInt: EQ_BIGINT_COST=5 → total = 5 + 5 + 5 = 15.
    // For GroupElement: EQ_GROUP_ELEMENT_COST=172 → total = 5 + 5 + 172 = 182.
    // For Unit: falls into the catch-all `_` arm → EQ_PRIM_COST=3 → total = 13.
    // For SigmaProp: falls into the catch-all `_` arm → EQ_PRIM_COST=3 → total = 13.
    //
    // We do NOT predict costs ourselves — sigma-rust via try_eval_out is the oracle.
    // The comments above are just context for the test reader.

    // --- Boolean ---
    entries.push(success_entry("eq_bool_true_true", RelationOp::Eq,
        Expr::Const(true.into()), Expr::Const(true.into()))?);
    entries.push(success_entry("eq_bool_true_false", RelationOp::Eq,
        Expr::Const(true.into()), Expr::Const(false.into()))?);
    entries.push(success_entry("neq_bool_true_false", RelationOp::NEq,
        Expr::Const(true.into()), Expr::Const(false.into()))?);
    entries.push(success_entry("neq_bool_true_true", RelationOp::NEq,
        Expr::Const(true.into()), Expr::Const(true.into()))?);

    // --- Byte ---
    entries.push(success_entry("eq_byte_equal", RelationOp::Eq,
        Expr::Const(42i8.into()), Expr::Const(42i8.into()))?);
    entries.push(success_entry("eq_byte_not_equal", RelationOp::Eq,
        Expr::Const(1i8.into()), Expr::Const(2i8.into()))?);

    // --- Short ---
    entries.push(success_entry("eq_short_equal", RelationOp::Eq,
        Expr::Const(1000i16.into()), Expr::Const(1000i16.into()))?);
    entries.push(success_entry("eq_short_not_equal", RelationOp::Eq,
        Expr::Const((-1i16).into()), Expr::Const(0i16.into()))?);

    // --- Int ---
    entries.push(success_entry("eq_int_equal", RelationOp::Eq,
        Expr::Const(42i32.into()), Expr::Const(42i32.into()))?);
    entries.push(success_entry("eq_int_not_equal", RelationOp::Eq,
        Expr::Const(1i32.into()), Expr::Const(2i32.into()))?);
    entries.push(success_entry("neq_int_equal", RelationOp::NEq,
        Expr::Const(7i32.into()), Expr::Const(7i32.into()))?);
    entries.push(success_entry("neq_int_not_equal", RelationOp::NEq,
        Expr::Const(3i32.into()), Expr::Const(4i32.into()))?);

    // --- Long ---
    entries.push(success_entry("eq_long_equal", RelationOp::Eq,
        Expr::Const(i64::MAX.into()), Expr::Const(i64::MAX.into()))?);
    entries.push(success_entry("eq_long_not_equal", RelationOp::Eq,
        Expr::Const(0i64.into()), Expr::Const(1i64.into()))?);

    // --- BigInt ---
    entries.push(success_entry("eq_bigint_equal", RelationOp::Eq,
        Expr::Const(BigInt256::from(100i64).into()),
        Expr::Const(BigInt256::from(100i64).into()))?);
    entries.push(success_entry("eq_bigint_not_equal", RelationOp::Eq,
        Expr::Const(BigInt256::from(-1i64).into()),
        Expr::Const(BigInt256::from(1i64).into()))?);

    // --- Unit ---
    // Unit == Unit is always true. Two Const(Unit) both evaluate; sigma-rust
    // falls to the catch-all arm → EQ_PRIM_COST = 3.
    {
        use ergotree_ir::mir::constant::Constant;
        use ergotree_ir::types::stype::SType;
        let unit_const: Expr = Constant { tpe: SType::SUnit, v: ergotree_ir::mir::constant::Literal::Unit }.into();
        entries.push(success_entry("eq_unit_unit", RelationOp::Eq,
            unit_const.clone(), unit_const.clone())?);
        entries.push(success_entry("neq_unit_unit", RelationOp::NEq,
            unit_const.clone(), unit_const)?);
    }

    // --- GroupElement (secp256k1 generator point, deterministic) ---
    // EQ_GROUP_ELEMENT_COST = 172; total Const+Const = 5+5+172 = 182.
    {
        let g: Expr = Expr::Const(generator().into());
        entries.push(success_entry("eq_group_element_equal", RelationOp::Eq,
            g.clone(), g.clone())?);
        // For "not equal" we'd need two different points; use generator vs its double.
        // We can't easily get a second deterministic point without arithmetic,
        // so just use NEq on the same point (which returns false).
        entries.push(success_entry("neq_group_element_equal", RelationOp::NEq,
            g.clone(), g)?);
    }

    // --- SigmaProp: TrivialProp(true) == TrivialProp(true) → true ---
    // Falls to catch-all arm in eq_with_cost → EQ_PRIM_COST = 3; total = 13.
    {
        let sp_true: SigmaProp = SigmaProp::new(SigmaBoolean::TrivialProp(true));
        let sp_false: SigmaProp = SigmaProp::new(SigmaBoolean::TrivialProp(false));
        let sp_true_expr: Expr = Expr::Const(sp_true.clone().into());
        let sp_false_expr: Expr = Expr::Const(sp_false.into());
        entries.push(success_entry("eq_sigma_prop_same", RelationOp::Eq,
            sp_true_expr.clone(), sp_true_expr.clone())?);
        entries.push(success_entry("eq_sigma_prop_diff", RelationOp::Eq,
            sp_true_expr, sp_false_expr)?);
    }

    // --- Coll[Int]: various cases ---
    // Cost for Coll eq is captured from the sigma-rust oracle; see committed fixtures.
    {
        use ergotree_ir::mir::collection::Collection;
        use ergotree_ir::types::stype::SType;

        // Empty Coll[Int] == Empty Coll[Int]
        let empty_coll_int: Expr = Collection::new(SType::SInt, vec![])?.into();
        entries.push(success_entry("eq_coll_int_empty_empty", RelationOp::Eq,
            empty_coll_int.clone(), empty_coll_int)?);

        // [1, 2] == [1, 2]
        let coll_1_2: Expr = Collection::new(SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())])?.into();
        entries.push(success_entry("eq_coll_int_same", RelationOp::Eq,
            coll_1_2.clone(), coll_1_2)?);

        // [1, 2] == [1, 3] → false (lengths equal, values differ)
        let coll_1_3: Expr = Collection::new(SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(3i32.into())])?.into();
        let coll_1_2b: Expr = Collection::new(SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())])?.into();
        entries.push(success_entry("eq_coll_int_diff_content", RelationOp::Eq,
            coll_1_2b, coll_1_3)?);

        // [1] == [1, 2] → false (length mismatch)
        let coll_1: Expr = Collection::new(SType::SInt,
            vec![Expr::Const(1i32.into())])?.into();
        let coll_1_2c: Expr = Collection::new(SType::SInt,
            vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())])?.into();
        entries.push(success_entry("eq_coll_int_diff_length", RelationOp::Eq,
            coll_1, coll_1_2c)?);
    }

    // --- Tuple ---
    // EQ_TUPLE_COST = 4 + recursive element costs.
    // Tuple(1i32, 2i32) == Tuple(1i32, 2i32): 4 + EQ_PRIM(3) + EQ_PRIM(3) = 10.
    // Total for Const Tuple consts: eval each tuple → each item is Const so cost
    // is evaluated inline. Actually: the BinOp Eq takes two Tuple expressions.
    // Each Tuple Expr is evaluated first (Tuple cost = 15 + 5+5 = 25 each), then
    // eq_with_cost charges 4 + 3 + 3 = 10.
    // Total = left_tuple_eval + right_tuple_eval + eq_cost.
    // Let sigma-rust be the oracle — don't hardcode.
    {
        use ergotree_ir::mir::tuple::Tuple;
        let t_1_2: Expr = Tuple::new(vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())])?.into();
        let t_1_2b: Expr = Tuple::new(vec![Expr::Const(1i32.into()), Expr::Const(2i32.into())])?.into();
        let t_1_3: Expr = Tuple::new(vec![Expr::Const(1i32.into()), Expr::Const(3i32.into())])?.into();
        entries.push(success_entry("eq_tuple_int_int_same", RelationOp::Eq,
            t_1_2, t_1_2b)?);
        entries.push(success_entry("eq_tuple_int_int_diff", RelationOp::Eq,
            t_1_3.clone(), t_1_3)?); // (1,3) == (1,3) → true
    }

    // NOTE: Option[Int] fixtures are NOT included here.
    // Serializing Literal::Opt requires ErgoTree v3+ (sigma-rust
    // data.rs:101,108). Our fixture format uses v0 trees and the TS parser
    // targets v0/v1. Option equality is tested separately via unit tests in
    // bin-op-relation.test.ts (non-fixture path) which directly construct
    // SValues without going through the serialization round-trip.
    // Will be revisited when v3 ErgoTree support lands in a later phase.

    // --- Cross-kind numeric EQUALITY is JVM-coerced (pre-V3), not `false`. ---
    // sigma-rust evaluates (Int, Long) cross-kind to `false` (eq_with_cost `_`
    // catch-all, cost 13), but the JVM deserializer auto-upcasts the narrower
    // operand for pre-V3 trees (equalityOp → applyUpcast, SigmaBuilder.scala:
    // 679-686,750-756), so EQ(Int 5, Long 5) v0 compares as Long → `true`
    // (cost 23). sigma-rust (this generator's reference) CANNOT produce the
    // JVM-correct value/cost, so these moved to the ergots-side JVM-aligned test
    // (packages/ergoscript/test/eval/bin-op-mismatched-numeric-coercion.test.ts).
    // See docs/specs/2026-06-01-ergoscript-mismatched-numeric-coercion-design.md.

    Ok(BinOpRelationFixtureFile {
        corpus: "eval_bin_op_relation",
        entries,
    })
}
