//! BinOp.Bit family — fixtures for the three bitwise ops
//! (`BitAnd`, `BitOr`, `BitXor`) that sigma-rust implements in BinOp eval,
//! plus error-case fixtures for kind-mismatch and non-numeric operands.
//!
//! Sigma-rust ref:
//!   `ergotree-interpreter/src/eval/bin_op.rs:215-217`
//!   ```
//!   BinOpKind::Bit(_) => {
//!       ctx.add_jit_cost(1)?;  // BitOp (all 6) = Fixed(1)
//!   }
//!   ```
//!   `bin_op.rs:342-391` — BitAnd/BitOr/BitXor eval via `eval_bit_op`;
//!   BitShiftLeft/Right/RightZeroed return `EvalError::Misc("no interpreter eval")`.
//!
//! Cost: envelope Fixed(1) + Const eval cost (5 per const operand).
//! Example: BitAnd(Int, Int) = 1 + 5 + 5 = 11 total (two Const leaves).
//!
//! Schema: each entry carries EITHER `expected_value_json` + `expected_cost`
//! (success case) OR `expected_error_code: Some(code)` (error case).
//! The `expected_value_json` field is null and `expected_cost` is 0 for error
//! entries; `expected_error_code` is null for success entries.
//! The TS side uses a unified schema matching the PLAN.md Task 4 template.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{BinOp, BinOpKind, BitOp};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use num_traits::Bounded;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct BinOpBitFixture {
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
pub struct BinOpBitFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<BinOpBitFixture>,
}

/// Build a BinOp tree: `BinOp { op: Bit(op), left: Const(lv), right: Const(rv) }`.
fn build_bit_tree(op: BitOp, lv: Expr, rv: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = BinOp {
        kind: BinOpKind::Bit(op),
        left: Box::new(lv),
        right: Box::new(rv),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Success entry: runs sigma-rust to get (value, cost).
fn success_entry(
    name: &str,
    op: BitOp,
    lv: Expr,
    rv: Expr,
) -> anyhow::Result<BinOpBitFixture> {
    let (tree, hex) = build_bit_tree(op, lv, rv)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(BinOpBitFixture {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Error entry: sigma-rust eval is expected to fail.
/// We build the tree (for the TS side to parse) but capture the TS-side
/// error code rather than a sigma-rust value — these entries drive the TS
/// error-handling paths.
fn error_entry(name: &str, op: BitOp, lv: Expr, rv: Expr, code: &str) -> anyhow::Result<BinOpBitFixture> {
    let (_tree, hex) = build_bit_tree(op, lv, rv)?;
    Ok(BinOpBitFixture {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<BinOpBitFixtureFile> {
    let mut entries: Vec<BinOpBitFixture> = Vec::new();

    // -------------------------------------------------------------------------
    // BitAnd — 5 numeric kinds
    // -------------------------------------------------------------------------
    entries.push(success_entry(
        "bitand_byte",
        BitOp::BitAnd,
        Expr::Const((0b1010_1010u8 as i8).into()),
        Expr::Const((0b1100_1100u8 as i8).into()),
    )?);

    entries.push(success_entry(
        "bitand_short",
        BitOp::BitAnd,
        Expr::Const(0x00FFi16.into()),
        Expr::Const(0x0F0Fi16.into()),
    )?);

    entries.push(success_entry(
        "bitand_int",
        BitOp::BitAnd,
        Expr::Const((0x_FFFF_0000u32 as i32).into()),
        Expr::Const((0x_F0F0_F0F0u32 as i32).into()),
    )?);

    entries.push(success_entry(
        "bitand_long",
        BitOp::BitAnd,
        Expr::Const((0x_AAAA_BBBB_CCCC_DDDDu64 as i64).into()),
        Expr::Const((0x_FFFF_0000_FFFF_0000u64 as i64).into()),
    )?);

    entries.push(success_entry(
        "bitand_bigint",
        BitOp::BitAnd,
        Expr::Const(BigInt256::from(i64::MAX).into()),
        Expr::Const(BigInt256::from(i64::MIN).into()),
    )?);

    // -------------------------------------------------------------------------
    // BitOr — 2 kinds (Int + Long as baselines)
    // -------------------------------------------------------------------------
    entries.push(success_entry(
        "bitor_int",
        BitOp::BitOr,
        Expr::Const(0x0000_FFFFi32.into()),
        Expr::Const((0xFFFF_0000u32 as i32).into()),
    )?);

    entries.push(success_entry(
        "bitor_long",
        BitOp::BitOr,
        Expr::Const(0i64.into()),
        Expr::Const((-1i64).into()),
    )?);

    // -------------------------------------------------------------------------
    // BitXor — 2 kinds (Int + Long as baselines)
    // -------------------------------------------------------------------------
    entries.push(success_entry(
        "bitxor_int",
        BitOp::BitXor,
        Expr::Const((0x_AAAA_AAAAu32 as i32).into()),
        Expr::Const(0x_5555_5555i32.into()),
    )?);

    entries.push(success_entry(
        "bitxor_long",
        BitOp::BitXor,
        Expr::Const((-1i64).into()),
        Expr::Const(i64::MIN.into()),
    )?);

    // -------------------------------------------------------------------------
    // Spot-checks: one each for remaining kinds × additional ops
    // -------------------------------------------------------------------------
    // BitOr on Byte
    entries.push(success_entry(
        "bitor_byte",
        BitOp::BitOr,
        Expr::Const(0b0011_0011i8.into()),
        Expr::Const((0b1100_1100u8 as i8).into()),
    )?);

    // BitXor on Short
    entries.push(success_entry(
        "bitxor_short",
        BitOp::BitXor,
        Expr::Const(0x00FFi16.into()),
        Expr::Const((0xFF00u16 as i16).into()),
    )?);

    // BitAnd on BigInt — edge: max & min = 0 (from sigma-rust bigint test)
    entries.push(success_entry(
        "bitand_bigint_max_min",
        BitOp::BitAnd,
        Expr::Const(BigInt256::max_value().into()),
        Expr::Const(BigInt256::min_value().into()),
    )?);

    // BitOr / BitXor on BigInt — exercises the 256-bit masking path that
    // BitAnd alone leaves uncovered. Two entries each: a sign-bit case via
    // i64::MAX / i64::MIN sign-extended to 256-bit, and a full-width case
    // via BigInt256::max_value / min_value.
    entries.push(success_entry(
        "bitor_bigint",
        BitOp::BitOr,
        Expr::Const(BigInt256::from(i64::MAX).into()),
        Expr::Const(BigInt256::from(i64::MIN).into()),
    )?);

    entries.push(success_entry(
        "bitor_bigint_max_min",
        BitOp::BitOr,
        Expr::Const(BigInt256::max_value().into()),
        Expr::Const(BigInt256::min_value().into()),
    )?);

    entries.push(success_entry(
        "bitxor_bigint",
        BitOp::BitXor,
        Expr::Const(BigInt256::from(i64::MAX).into()),
        Expr::Const(BigInt256::from(i64::MIN).into()),
    )?);

    entries.push(success_entry(
        "bitxor_bigint_max_min",
        BitOp::BitXor,
        Expr::Const(BigInt256::max_value().into()),
        Expr::Const(BigInt256::min_value().into()),
    )?);


    // -------------------------------------------------------------------------
    // Error: kind mismatch — Int left, Long right for BitAnd.
    // Sigma-rust's try_extract_into::<i32> on a Long Value returns
    // EvalError::InvalidType. TS maps this to 'bin-op-kind-mismatch'.
    // -------------------------------------------------------------------------
    entries.push(error_entry(
        "bitand_kind_mismatch_int_long",
        BitOp::BitAnd,
        Expr::Const(42i32.into()),
        Expr::Const(42i64.into()),
        "bin-op-kind-mismatch",
    )?);

    // -------------------------------------------------------------------------
    // Error: non-numeric operand — Boolean + Boolean for BitAnd.
    // Sigma-rust falls through to the `_ => EvalError::UnexpectedValue` arm.
    // TS maps this to 'bin-op-not-numeric'.
    // -------------------------------------------------------------------------
    entries.push(error_entry(
        "bitand_not_numeric_bool",
        BitOp::BitAnd,
        Expr::Const(true.into()),
        Expr::Const(true.into()),
        "bin-op-not-numeric",
    )?);

    // -------------------------------------------------------------------------
    // Shift ops: sigma-rust returns EvalError::Misc for these via BinOp.
    // TS mirrors with 'not-implemented-yet' (shifts use SNumericTypeMethods).
    // One entry each to cover the three shift variants.
    // -------------------------------------------------------------------------
    entries.push(error_entry(
        "bit_shift_left_not_impl",
        BitOp::BitShiftLeft,
        Expr::Const(1i32.into()),
        Expr::Const(1i32.into()),
        "not-implemented-yet",
    )?);

    entries.push(error_entry(
        "bit_shift_right_not_impl",
        BitOp::BitShiftRight,
        Expr::Const(1i32.into()),
        Expr::Const(1i32.into()),
        "not-implemented-yet",
    )?);

    entries.push(error_entry(
        "bit_shift_right_zeroed_not_impl",
        BitOp::BitShiftRightZeroed,
        Expr::Const(1i32.into()),
        Expr::Const(1i32.into()),
        "not-implemented-yet",
    )?);

    Ok(BinOpBitFixtureFile {
        corpus: "eval_bin_op_bit",
        entries,
    })
}
