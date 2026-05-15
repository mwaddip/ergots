//! BinOp.Relation family — fixtures for the four ordering ops
//! (`Lt`, `Le`, `Gt`, `Ge`) on Byte/Short/Int/Long/BigInt operands.
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
//! Cost: envelope Fixed(20) + Const eval cost (5 per const operand evaluated).
//! Both operands always eval: no short-circuit for ordering ops.
//! Total for Const+Const operands = 20 + 5 + 5 = 30.
//!
//! NOTE: Eq/NEq are NOT included here — Task 7 adds them alongside the
//! `sValueEquals` recursive comparer. Do not add them to this file.
//!
//! Error cases:
//!   - `bin-op-not-numeric`: non-numeric left operand (e.g. Boolean).
//!   - `bin-op-kind-mismatch`: left and right operands have different kinds.
//!
//! Schema: same unified struct as bin_op_bit — `expected_error_code` is null
//! for success entries, `expected_value_json`/`expected_cost` are null/0 for
//! error entries.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{BinOp, BinOpKind, RelationOp};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
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
    // Error: kind mismatch — Int left, Long right for Lt.
    // Sigma-rust's try_extract_into::<i32> on a Long Value returns EvalError::InvalidType.
    // TS maps this to 'bin-op-kind-mismatch'.
    // -------------------------------------------------------------------------
    entries.push(error_entry(
        "lt_kind_mismatch_int_long",
        RelationOp::Lt,
        Expr::Const(1i32.into()),
        Expr::Const(2i64.into()),
        "bin-op-kind-mismatch",
    )?);

    entries.push(error_entry(
        "ge_kind_mismatch_short_int",
        RelationOp::Ge,
        Expr::Const(1i16.into()),
        Expr::Const(2i32.into()),
        "bin-op-kind-mismatch",
    )?);

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

    Ok(BinOpRelationFixtureFile {
        corpus: "eval_bin_op_relation",
        entries,
    })
}
