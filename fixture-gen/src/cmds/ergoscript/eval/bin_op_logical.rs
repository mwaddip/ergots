//! BinOp.Logical family — fixtures for `And`, `Or`, and `Xor` on Boolean.
//!
//! Sigma-rust ref:
//!   `ergotree-interpreter/src/eval/bin_op.rs:212-214`
//!   ```
//!   BinOpKind::Logical(_) => {
//!       ctx.add_jit_cost(20)?; // BinOr, BinAnd, BinXor = Fixed(20)
//!   }
//!   ```
//!   `bin_op.rs:222-235` — And/Or short-circuit via lazy `rv` closure; Xor eager.
//!
//! Cost: envelope Fixed(20) + Const eval cost (5 per const operand evaluated).
//! Short-circuit: And with left=false does NOT eval right (cost = 20 + 5 = 25).
//!                Or with left=true does NOT eval right (cost = 20 + 5 = 25).
//!                Xor always evals both (cost = 20 + 5 + 5 = 30).
//!
//! Short-circuit proof: the cost differential in the truth table entries is the
//! fixture-level proof — And(false, true) costs 25 (envelope=20 + left=5, right
//! NOT charged), while And(true, true) costs 30 (envelope=20 + left=5 + right=5).
//!
//! NOTE: The TS parser validates ConstantPlaceholder ids at parse time (unlike
//! sigma-rust which validates at eval time). Therefore we cannot use out-of-range
//! id=99 in fixture tree bytes — the TS parseTree call would fail before eval.
//! Short-circuit is proven via cost difference (25 vs 30 = right not charged).
//! The TS test file's inline semantic tests use out-of-range ConstPlaceholder(99)
//! via direct evalExpr (bypassing parseTree) for the "would throw if evaluated" proof.
//!
//! Schema: same as bin_op_bit — unified fixture struct with `expected_error_code`
//! (null for success entries) so the TS test loop handles both in one pass.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{BinOp, BinOpKind, LogicalOp};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct BinOpLogicalFixture {
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
pub struct BinOpLogicalFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<BinOpLogicalFixture>,
}

/// Build a BinOp.Logical tree (v0, no segregation).
fn build_logical_tree(op: LogicalOp, lv: Expr, rv: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = BinOp {
        kind: BinOpKind::Logical(op),
        left: Box::new(lv),
        right: Box::new(rv),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Success entry: both operands are Const; sigma-rust evaluates eagerly.
fn success_entry(
    name: &str,
    op: LogicalOp,
    lv: Expr,
    rv: Expr,
) -> anyhow::Result<BinOpLogicalFixture> {
    let (tree, hex) = build_logical_tree(op, lv, rv)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(BinOpLogicalFixture {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Error entry: sigma-rust would fail; we capture the expected TS error code.
fn error_entry(name: &str, op: LogicalOp, lv: Expr, rv: Expr, code: &str) -> anyhow::Result<BinOpLogicalFixture> {
    let (_tree, hex) = build_logical_tree(op, lv, rv)?;
    Ok(BinOpLogicalFixture {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<BinOpLogicalFixtureFile> {
    let mut entries: Vec<BinOpLogicalFixture> = Vec::new();

    // -------------------------------------------------------------------------
    // And — truth table (4 entries)
    // Cost: And(false, X) = 25 (left short-circuits); And(true, X) = 30 (both eval).
    // -------------------------------------------------------------------------
    entries.push(success_entry(
        "and_true_true",
        LogicalOp::And,
        Expr::Const(true.into()),
        Expr::Const(true.into()),
    )?);

    entries.push(success_entry(
        "and_true_false",
        LogicalOp::And,
        Expr::Const(true.into()),
        Expr::Const(false.into()),
    )?);

    // and_false_X: short-circuit — cost=25, proving right was NOT charged.
    entries.push(success_entry(
        "and_false_true",
        LogicalOp::And,
        Expr::Const(false.into()),
        Expr::Const(true.into()),
    )?);

    entries.push(success_entry(
        "and_false_false",
        LogicalOp::And,
        Expr::Const(false.into()),
        Expr::Const(false.into()),
    )?);

    // -------------------------------------------------------------------------
    // Or — truth table (4 entries)
    // Cost: Or(true, X) = 25 (left short-circuits); Or(false, X) = 30 (both eval).
    // -------------------------------------------------------------------------
    // or_true_X: short-circuit — cost=25, proving right was NOT charged.
    entries.push(success_entry(
        "or_true_true",
        LogicalOp::Or,
        Expr::Const(true.into()),
        Expr::Const(true.into()),
    )?);

    entries.push(success_entry(
        "or_true_false",
        LogicalOp::Or,
        Expr::Const(true.into()),
        Expr::Const(false.into()),
    )?);

    entries.push(success_entry(
        "or_false_true",
        LogicalOp::Or,
        Expr::Const(false.into()),
        Expr::Const(true.into()),
    )?);

    entries.push(success_entry(
        "or_false_false",
        LogicalOp::Or,
        Expr::Const(false.into()),
        Expr::Const(false.into()),
    )?);

    // -------------------------------------------------------------------------
    // Xor — truth table (4 entries, both sides always eval, cost always 30)
    // -------------------------------------------------------------------------
    entries.push(success_entry(
        "xor_true_true",
        LogicalOp::Xor,
        Expr::Const(true.into()),
        Expr::Const(true.into()),
    )?);

    entries.push(success_entry(
        "xor_true_false",
        LogicalOp::Xor,
        Expr::Const(true.into()),
        Expr::Const(false.into()),
    )?);

    entries.push(success_entry(
        "xor_false_true",
        LogicalOp::Xor,
        Expr::Const(false.into()),
        Expr::Const(true.into()),
    )?);

    entries.push(success_entry(
        "xor_false_false",
        LogicalOp::Xor,
        Expr::Const(false.into()),
        Expr::Const(false.into()),
    )?);

    // -------------------------------------------------------------------------
    // Error: non-Boolean operand — left is Const(5: SInt), right is Const(true).
    // TS throws 'bin-op-not-boolean'. One entry per op family.
    // -------------------------------------------------------------------------
    entries.push(error_entry(
        "and_not_boolean_left",
        LogicalOp::And,
        Expr::Const(5i32.into()),
        Expr::Const(true.into()),
        "bin-op-not-boolean",
    )?);

    entries.push(error_entry(
        "or_not_boolean_left",
        LogicalOp::Or,
        Expr::Const(5i32.into()),
        Expr::Const(true.into()),
        "bin-op-not-boolean",
    )?);

    entries.push(error_entry(
        "xor_not_boolean_left",
        LogicalOp::Xor,
        Expr::Const(5i32.into()),
        Expr::Const(true.into()),
        "bin-op-not-boolean",
    )?);

    Ok(BinOpLogicalFixtureFile {
        corpus: "eval_bin_op_logical",
        entries,
    })
}
