//! BinOp.Arith family — fixtures for the seven arithmetic ops
//! (Plus, Minus, Multiply, Divide, Max, Min, Modulo) on
//! Byte/Short/Int/Long/BigInt operands.
//!
//! Sigma-rust ref:
//!   `ergotree-interpreter/src/eval/bin_op.rs:184-218` — Evaluable impl,
//!   cost section:
//!   ```
//!   BinOpKind::Arith(op) => match op {
//!       ArithOp::Plus | ArithOp::Minus => {
//!           ctx.add_jit_cost(if is_bigint { 20 } else { 15 })?;
//!       }
//!       ArithOp::Multiply | ArithOp::Divide | ArithOp::Modulo => {
//!           ctx.add_jit_cost(if is_bigint { 25 } else { 15 })?;
//!       }
//!       ArithOp::Max | ArithOp::Min => {
//!           ctx.add_jit_cost(if is_bigint { 10 } else { 5 })?;
//!       }
//!   }
//!   ```
//!   is_bigint = matches!(lv, Value::BigInt(_) | Value::UnsignedBigInt(_))
//!
//! Cost ordering: eval left → derive is_bigint from lv → charge cost
//!                → eval right (matches sigma-rust bin_op.rs ordering).
//!
//! Overflow: Plus/Minus/Multiply/Divide/Modulo use checked_* (sigma-rust
//! checked_add/sub/mul/div/rem) which return None on overflow → EvalError.
//! Max/Min cannot overflow (use .max()/.min()).
//!
//! Divide-by-zero and modulo-by-zero: checked_div/rem return None for r==0.
//!
//! Schema: unified struct with `expected_error_code` = null for success entries.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use num_traits::Bounded;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct BinOpArithFixture {
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
pub struct BinOpArithFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<BinOpArithFixture>,
}

/// Build a BinOp.Arith tree (v0, no segregation).
fn build_arith_tree(op: ArithOp, lv: Expr, rv: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = BinOp {
        kind: BinOpKind::Arith(op),
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
    op: ArithOp,
    lv: Expr,
    rv: Expr,
) -> anyhow::Result<BinOpArithFixture> {
    let (tree, hex) = build_arith_tree(op, lv, rv)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(BinOpArithFixture {
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
    op: ArithOp,
    lv: Expr,
    rv: Expr,
    code: &str,
) -> anyhow::Result<BinOpArithFixture> {
    let (_tree, hex) = build_arith_tree(op, lv, rv)?;
    Ok(BinOpArithFixture {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<BinOpArithFixtureFile> {
    let mut entries: Vec<BinOpArithFixture> = Vec::new();

    // =========================================================================
    // Plus — 5 kinds
    // =========================================================================
    // Int: 1 + 2 = 3; cost = 15 (non-bigint Plus) + 5 (left Const) + 5 (right Const) = 25
    entries.push(success_entry(
        "plus_int_basic",
        ArithOp::Plus,
        Expr::Const(1i32.into()),
        Expr::Const(2i32.into()),
    )?);
    // Long: MAX-1 + 1 = MAX (no overflow)
    entries.push(success_entry(
        "plus_long_max_minus_1",
        ArithOp::Plus,
        Expr::Const((i64::MAX - 1).into()),
        Expr::Const(1i64.into()),
    )?);
    // Byte: -10 + 5 = -5
    entries.push(success_entry(
        "plus_byte_negative",
        ArithOp::Plus,
        Expr::Const((-10i8).into()),
        Expr::Const(5i8.into()),
    )?);
    // Short: 100 + 200 = 300
    entries.push(success_entry(
        "plus_short_basic",
        ArithOp::Plus,
        Expr::Const(100i16.into()),
        Expr::Const(200i16.into()),
    )?);
    // BigInt: 1 + 1 = 2; cost = 20 (bigint Plus) + 5 + 5 = 30
    entries.push(success_entry(
        "plus_bigint_basic",
        ArithOp::Plus,
        Expr::Const(BigInt256::from(1i64).into()),
        Expr::Const(BigInt256::from(1i64).into()),
    )?);

    // =========================================================================
    // Minus — Int + Long
    // =========================================================================
    entries.push(success_entry(
        "minus_int_basic",
        ArithOp::Minus,
        Expr::Const(10i32.into()),
        Expr::Const(3i32.into()),
    )?);
    entries.push(success_entry(
        "minus_long_basic",
        ArithOp::Minus,
        Expr::Const(100i64.into()),
        Expr::Const(1i64.into()),
    )?);
    // Long: MIN + 1 - 1 = MIN (no overflow)
    entries.push(success_entry(
        "minus_long_min_plus1",
        ArithOp::Minus,
        Expr::Const((i64::MIN + 1).into()),
        Expr::Const(1i64.into()),
    )?);

    // =========================================================================
    // Multiply — Int + Long + BigInt
    // =========================================================================
    entries.push(success_entry(
        "multiply_int_basic",
        ArithOp::Multiply,
        Expr::Const(6i32.into()),
        Expr::Const(7i32.into()),
    )?);
    entries.push(success_entry(
        "multiply_long_basic",
        ArithOp::Multiply,
        Expr::Const(1000i64.into()),
        Expr::Const(1000i64.into()),
    )?);
    // MAX_INT * 1 = MAX_INT (no overflow)
    entries.push(success_entry(
        "multiply_int_max_by_1",
        ArithOp::Multiply,
        Expr::Const(i32::MAX.into()),
        Expr::Const(1i32.into()),
    )?);
    // BigInt: 2 * 3 = 6; cost = 25 (bigint Multiply) + 5 + 5 = 35
    entries.push(success_entry(
        "multiply_bigint_basic",
        ArithOp::Multiply,
        Expr::Const(BigInt256::from(2i64).into()),
        Expr::Const(BigInt256::from(3i64).into()),
    )?);

    // =========================================================================
    // Divide — Int + Long
    // =========================================================================
    entries.push(success_entry(
        "divide_int_basic",
        ArithOp::Divide,
        Expr::Const(10i32.into()),
        Expr::Const(3i32.into()),
    )?);
    entries.push(success_entry(
        "divide_long_basic",
        ArithOp::Divide,
        Expr::Const(100i64.into()),
        Expr::Const(7i64.into()),
    )?);
    // Negative dividend: -10 / 3 = -3 (truncates toward zero)
    entries.push(success_entry(
        "divide_int_negative_dividend",
        ArithOp::Divide,
        Expr::Const((-10i32).into()),
        Expr::Const(3i32.into()),
    )?);

    // =========================================================================
    // Modulo — Int + Long
    // =========================================================================
    entries.push(success_entry(
        "modulo_int_basic",
        ArithOp::Modulo,
        Expr::Const(10i32.into()),
        Expr::Const(3i32.into()),
    )?);
    entries.push(success_entry(
        "modulo_long_basic",
        ArithOp::Modulo,
        Expr::Const(100i64.into()),
        Expr::Const(7i64.into()),
    )?);

    // =========================================================================
    // Max — Int + Long + BigInt
    // =========================================================================
    entries.push(success_entry(
        "max_int_basic",
        ArithOp::Max,
        Expr::Const(5i32.into()),
        Expr::Const(10i32.into()),
    )?);
    entries.push(success_entry(
        "max_long_basic",
        ArithOp::Max,
        Expr::Const(i64::MAX.into()),
        Expr::Const(0i64.into()),
    )?);
    // BigInt Max; cost = 10 (bigint Max) + 5 + 5 = 20
    entries.push(success_entry(
        "max_bigint_basic",
        ArithOp::Max,
        Expr::Const(BigInt256::from(-1i64).into()),
        Expr::Const(BigInt256::from(1i64).into()),
    )?);

    // =========================================================================
    // Min — Int + Long
    // =========================================================================
    entries.push(success_entry(
        "min_int_basic",
        ArithOp::Min,
        Expr::Const(5i32.into()),
        Expr::Const(10i32.into()),
    )?);
    entries.push(success_entry(
        "min_long_basic",
        ArithOp::Min,
        Expr::Const(i64::MIN.into()),
        Expr::Const(0i64.into()),
    )?);

    // =========================================================================
    // Boundary / overflow cases
    // =========================================================================
    // MAX_INT + 1 → overflow error
    entries.push(error_entry(
        "plus_int_overflow",
        ArithOp::Plus,
        Expr::Const(i32::MAX.into()),
        Expr::Const(1i32.into()),
        "arith-overflow",
    )?);
    // MIN_INT - 1 → overflow error
    entries.push(error_entry(
        "minus_int_underflow",
        ArithOp::Minus,
        Expr::Const(i32::MIN.into()),
        Expr::Const(1i32.into()),
        "arith-overflow",
    )?);
    // MAX_LONG + 1 → overflow error
    entries.push(error_entry(
        "plus_long_overflow",
        ArithOp::Plus,
        Expr::Const(i64::MAX.into()),
        Expr::Const(1i64.into()),
        "arith-overflow",
    )?);
    // MAX_LONG * 2 → overflow error
    entries.push(error_entry(
        "multiply_long_overflow",
        ArithOp::Multiply,
        Expr::Const(i64::MAX.into()),
        Expr::Const(2i64.into()),
        "arith-overflow",
    )?);
    // BigInt MAX * 2 → overflow error
    entries.push(error_entry(
        "multiply_bigint_overflow",
        ArithOp::Multiply,
        Expr::Const(BigInt256::max_value().into()),
        Expr::Const(BigInt256::from(2i64).into()),
        "arith-overflow",
    )?);
    // BigInt MIN + (-1) → overflow error
    entries.push(error_entry(
        "plus_bigint_underflow",
        ArithOp::Plus,
        Expr::Const(BigInt256::min_value().into()),
        Expr::Const(BigInt256::from(-1i64).into()),
        "arith-overflow",
    )?);

    // =========================================================================
    // Divide-by-zero and modulo-by-zero
    // =========================================================================
    // Divide Int by 0
    entries.push(error_entry(
        "divide_int_by_zero",
        ArithOp::Divide,
        Expr::Const(5i32.into()),
        Expr::Const(0i32.into()),
        "arith-divide-by-zero",
    )?);
    // Divide Long by 0
    entries.push(error_entry(
        "divide_long_by_zero",
        ArithOp::Divide,
        Expr::Const(100i64.into()),
        Expr::Const(0i64.into()),
        "arith-divide-by-zero",
    )?);
    // Modulo Int by 0
    entries.push(error_entry(
        "modulo_int_by_zero",
        ArithOp::Modulo,
        Expr::Const(5i32.into()),
        Expr::Const(0i32.into()),
        "arith-divide-by-zero",
    )?);
    // Modulo Long by 0
    entries.push(error_entry(
        "modulo_long_by_zero",
        ArithOp::Modulo,
        Expr::Const(20i64.into()),
        Expr::Const(0i64.into()),
        "arith-divide-by-zero",
    )?);

    // =========================================================================
    // Mismatched-numeric arith is NO LONGER a rejection here.
    //
    // The JVM deserializer auto-upcasts the narrower numeric operand for pre-V3
    // ErgoTree versions (DeserializationSigmaBuilder.applyUpcast,
    // SigmaBuilder.scala:750-756), so e.g. Plus(Int, Long) v0 evaluates as Long.
    // sigma-rust (this generator's reference) still rejects it at eval and so
    // CANNOT produce the JVM-correct value/cost — these cases therefore moved to
    // the ergots-side JVM-aligned test
    // (packages/ergoscript/test/eval/bin-op-mismatched-numeric-coercion.test.ts),
    // to be re-blessed from the SANTA conformance vector when it lands. See
    // docs/specs/2026-06-01-ergoscript-mismatched-numeric-coercion-design.md.
    // (Bit ops are NOT in the upcast class — BitOp bypasses applyUpcast — so the
    // bin_op_bit `bitand_n_int_long` rejection stays.)
    // =========================================================================

    // =========================================================================
    // Non-numeric operand: Boolean Plus Boolean
    // =========================================================================
    entries.push(error_entry(
        "plus_not_numeric_bool",
        ArithOp::Plus,
        Expr::Const(true.into()),
        Expr::Const(false.into()),
        "bin-op-not-numeric",
    )?);

    Ok(BinOpArithFixtureFile {
        corpus: "eval_bin_op_arith",
        entries,
    })
}
