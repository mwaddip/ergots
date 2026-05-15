//! Negation arm — fixtures for `Expr::Negation(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/negation.rs:16`
//!   ctx.add_jit_cost(30)?;                      // Negation = Fixed(30)
//!   let input_v = self.input.eval(env, ctx)?;   // eval child AFTER charging cost
//!   match input_v {
//!       Value::Byte(v)   => neg(&v),
//!       Value::Short(v)  => neg(&v),
//!       Value::Int(v)    => neg(&v),
//!       Value::Long(v)   => neg(&v),
//!       Value::BigInt(v) => neg(&v),
//!       _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! `neg` invokes `checked_neg` per primitive — returns `None` for
//! `MIN_K`, surfaced as `EvalError::ArithmeticException`. On the TS
//! side we reuse `'arith-overflow'` (same code 2c's BinOp.Arith
//! overflow path uses).
//!
//! Cost ordering: envelope charged BEFORE eval-child (sigma-rust line
//! 16 → 17). Same posture as LogicalNot / BitInversion.
//!
//! Coverage:
//!   - 5 kinds × 2 happy values (0 + MAX_K) = 10 success entries.
//!   - 5 overflow entries (`Negate(MIN_K)` per kind) → `'arith-overflow'`.
//!   - 1 cost-limit entry (`jitCostLimit` < per-arm cost) → `'cost-limit-exceeded'`.
//!
//! Non-numeric error case is NOT generated here. `Negation::try_build`
//! (`ergotree-ir/src/mir/negation.rs:38-50`) rejects non-numeric input
//! at build time with `InvalidArgumentError`, so we cannot serialize a
//! malformed tree through the standard path. The TS-side
//! `'bin-op-not-numeric'` assertion is covered by an inline test that
//! calls `evalExpr` directly with a hand-built MIR node (BitInversion
//! precedent — `packages/ergoscript/test/eval/bit-inversion.test.ts`).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::negation::Negation;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use num_traits::Bounded;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct NegationFixture {
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
pub struct NegationFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<NegationFixture>,
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = Negation::try_build(input)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, input: Expr) -> anyhow::Result<NegationFixture> {
    let (tree, hex) = build_tree(input)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(NegationFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Overflow entry — input is numeric (so `try_build` accepts it) but
/// `Negate(MIN_K)` exceeds the signed range. Sigma-rust raises
/// `EvalError::ArithmeticException`; we capture the TS-side code
/// `'arith-overflow'` statically (matching `bin_op_arith.rs` precedent
/// — the `error_entry` helper there doesn't run sigma-rust eval, just
/// builds the tree bytes and assigns the TS error code).
fn overflow_entry(name: &str, input: Expr) -> anyhow::Result<NegationFixture> {
    let (_tree, hex) = build_tree(input)?;
    Ok(NegationFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("arith-overflow"),
    })
}

/// Cost-limit entry — `jitCostLimit` set below the per-arm cost (30) so
/// `addCost` overshoots on the very first cost call. Sigma-rust path
/// raises `CostLimitExceeded`; TS-side throws `'cost-limit-exceeded'`.
/// The tree bytes are valid; only the limit makes evaluation fail.
fn cost_limit_entry(name: &str, input: Expr, limit: u64) -> anyhow::Result<NegationFixture> {
    let (_tree, hex) = build_tree(input)?;
    Ok(NegationFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<NegationFixtureFile> {
    let mut entries = Vec::new();

    // =========================================================================
    // Happy entries — 5 kinds × 2 boundary values (0, MAX_K)
    //   Negate(0) = 0; Negate(MAX_K) = MIN_K + 1 (no overflow).
    // =========================================================================
    entries.push(success_entry("negation_byte_zero", Expr::Const(0i8.into()))?);
    entries.push(success_entry("negation_byte_max", Expr::Const(i8::MAX.into()))?);

    entries.push(success_entry("negation_short_zero", Expr::Const(0i16.into()))?);
    entries.push(success_entry("negation_short_max", Expr::Const(i16::MAX.into()))?);

    entries.push(success_entry("negation_int_zero", Expr::Const(0i32.into()))?);
    entries.push(success_entry("negation_int_max", Expr::Const(i32::MAX.into()))?);

    entries.push(success_entry("negation_long_zero", Expr::Const(0i64.into()))?);
    entries.push(success_entry("negation_long_max", Expr::Const(i64::MAX.into()))?);

    entries.push(success_entry(
        "negation_bigint_zero",
        Expr::Const(BigInt256::from(0i64).into()),
    )?);
    entries.push(success_entry(
        "negation_bigint_max",
        Expr::Const(BigInt256::max_value().into()),
    )?);

    // =========================================================================
    // Overflow entries — Negate(MIN_K) for each kind. checked_neg returns
    // None because |MIN_K| = MAX_K + 1 lies outside the signed range.
    // =========================================================================
    entries.push(overflow_entry(
        "negation_byte_min_overflow",
        Expr::Const(i8::MIN.into()),
    )?);
    entries.push(overflow_entry(
        "negation_short_min_overflow",
        Expr::Const(i16::MIN.into()),
    )?);
    entries.push(overflow_entry(
        "negation_int_min_overflow",
        Expr::Const(i32::MIN.into()),
    )?);
    entries.push(overflow_entry(
        "negation_long_min_overflow",
        Expr::Const(i64::MIN.into()),
    )?);
    entries.push(overflow_entry(
        "negation_bigint_min_overflow",
        Expr::Const(BigInt256::min_value().into()),
    )?);

    // =========================================================================
    // Cost-limit entry — jitCostLimit = 10 < Negation's 30 cost.
    // The very first ctx.addCost(30) overshoots and throws.
    // =========================================================================
    entries.push(cost_limit_entry(
        "negation_cost_limit_exceeded",
        Expr::Const(0i32.into()),
        10,
    )?);

    Ok(NegationFixtureFile {
        corpus: "eval_negation",
        entries,
    })
}
