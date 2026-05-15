//! BitInversion arm — fixtures for `Expr::BitInversion(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/bit_inversion.rs:15`
//!   ctx.add_jit_cost(1)?;  // BitOp = Fixed(1)
//!   let input_v = self.input.eval(env, ctx)?;
//!   match input_v {
//!       Value::Byte(v) => Ok(Value::Byte(!v)),
//!       Value::Short(v) => Ok(Value::Short(!v)),
//!       Value::Int(v) => Ok(Value::Int(!v)),
//!       Value::Long(v) => Ok(Value::Long(!v)),
//!       Value::BigInt(v) => Ok(Value::BigInt(!v)),
//!       _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! Cost ordering: charge envelope BEFORE eval-child (matches LogicalNot).
//!
//! Coverage: 5 numeric kinds × 3 boundary values (0, MAX_K, MIN_K) = 15 entries.
//!
//! Non-numeric error case: `BitInversion::try_build` in sigma-rust
//! (`ergotree-ir/src/mir/bit_inversion.rs:38-50`) rejects non-numeric input at
//! build time with `InvalidArgumentError`, so we cannot serialize a malformed
//! tree through the standard path. The TS-side `'bin-op-not-numeric'`
//! assertion is therefore covered by an inline test that calls `evalExpr`
//! directly with a hand-built MIR node (LogicalNot precedent —
//! `packages/ergoscript/test/eval/logical-not.test.ts`).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bit_inversion::BitInversion;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use num_traits::Bounded;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct BitInversionFixture {
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
pub struct BitInversionFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<BitInversionFixture>,
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = BitInversion::try_build(input)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, input: Expr) -> anyhow::Result<BitInversionFixture> {
    let (tree, hex) = build_tree(input)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(BitInversionFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<BitInversionFixtureFile> {
    let mut entries = Vec::new();

    // Byte: 0, MAX, MIN
    entries.push(success_entry("bit_inversion_byte_zero", Expr::Const(0i8.into()))?);
    entries.push(success_entry("bit_inversion_byte_max", Expr::Const(i8::MAX.into()))?);
    entries.push(success_entry("bit_inversion_byte_min", Expr::Const(i8::MIN.into()))?);

    // Short: 0, MAX, MIN
    entries.push(success_entry("bit_inversion_short_zero", Expr::Const(0i16.into()))?);
    entries.push(success_entry("bit_inversion_short_max", Expr::Const(i16::MAX.into()))?);
    entries.push(success_entry("bit_inversion_short_min", Expr::Const(i16::MIN.into()))?);

    // Int: 0, MAX, MIN
    entries.push(success_entry("bit_inversion_int_zero", Expr::Const(0i32.into()))?);
    entries.push(success_entry("bit_inversion_int_max", Expr::Const(i32::MAX.into()))?);
    entries.push(success_entry("bit_inversion_int_min", Expr::Const(i32::MIN.into()))?);

    // Long: 0, MAX, MIN
    entries.push(success_entry("bit_inversion_long_zero", Expr::Const(0i64.into()))?);
    entries.push(success_entry("bit_inversion_long_max", Expr::Const(i64::MAX.into()))?);
    entries.push(success_entry("bit_inversion_long_min", Expr::Const(i64::MIN.into()))?);

    // BigInt: 0, MAX (full 256-bit), MIN (full 256-bit)
    entries.push(success_entry(
        "bit_inversion_bigint_zero",
        Expr::Const(BigInt256::from(0i64).into()),
    )?);
    entries.push(success_entry(
        "bit_inversion_bigint_max",
        Expr::Const(BigInt256::max_value().into()),
    )?);
    entries.push(success_entry(
        "bit_inversion_bigint_min",
        Expr::Const(BigInt256::min_value().into()),
    )?);

    // Non-numeric error case: skipped here. See module-level doc-comment.

    Ok(BitInversionFixtureFile {
        corpus: "eval_bit_inversion",
        entries,
    })
}
