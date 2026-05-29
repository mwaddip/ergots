//! MultiplyGroup arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/multiply_group.rs:9-29
//!   ctx.add_jit_cost(40)?;
//!   let left_v = self.left.eval(env, ctx)?;
//!   let right_v = self.right.eval(env, ctx)?;
//!   match (&left_v, &right_v) {
//!       (Value::GroupElement(l), Value::GroupElement(r)) => Ok(((**l) * r).into()),
//!       _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! Note: `(**l) * r` dispatches to Mul<&EcPoint> at ec_point.rs:74-80, which
//! is point ADDITION on the curve (multiplicative-notation group).
//!
//! Cost ordering: Pattern A — BEFORE eval-child. Fixed(40).
//!
//! Scenarios (6 success + 2 throw = 8):
//!   - mg_gen_gen               : g + g     (point doubling — non-trivial sanity)
//!   - mg_gen_identity          : g + 0 = g
//!   - mg_identity_identity     : 0 + 0 = 0
//!   - mg_distinct_points       : 2g + 3g = 5g (two distinct non-trivial points)
//!   - mg_asymmetric            : g + (-g) = 0  (curve additive inverse)
//!   - mg_inverse_then_doubling : 2g + (-g) = g (chain check)
//!   - mg_throw_non_grp_left    : Const(SInt, 42) left input → group-op-input-not-group-element
//!   - mg_throw_non_grp_right   : Const(SInt, 42) right input → group-op-input-not-group-element

use ergo_chain_types::ec_point::{generator, identity, inverse};
use ergo_chain_types::EcPoint;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::multiply_group::MultiplyGroup;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct MultiplyGroupFixture {
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
pub struct MultiplyGroupFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<MultiplyGroupFixture>,
}

/// Build a Const(SGroupElement, ec) expression. `From<EcPoint> for Constant`
/// is implemented in sigma-rust (matches create_prove_dlog.rs::build_tree
/// precedent at line 60-62).
fn const_group(ec: EcPoint) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = ec.into();
    c.into()
}

/// Build a Const(SInt, n) expression — used to synthesize the non-GroupElement
/// inputs that drive the build-time-bypass throw paths. `MultiplyGroup::new`
/// rejects non-(SGroupElement, SGroupElement) inputs at construction, so we
/// build the MIR struct directly without going through `new`.
fn const_int(n: i32) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = n.into();
    c.into()
}

fn build_tree(left: Expr, right: Expr) -> anyhow::Result<(ErgoTree, String)> {
    // Use MultiplyGroup::new — happy paths always have (SGroupElement, SGroupElement)
    // operands so construction succeeds.
    let node = MultiplyGroup::new(left, right)
        .map_err(|e| anyhow::anyhow!("MultiplyGroup::new: {:?}", e))?;
    let body: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Throw-path tree: build the MultiplyGroup MIR struct directly (bypassing
/// `MultiplyGroup::new`'s build-time `(SGroupElement, SGroupElement)` check).
/// This mirrors the byte_array_to_long / decode_point throw fixtures' approach
/// of synthesizing trees the standard path can't produce.
fn build_throw_tree(left: Expr, right: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let node = MultiplyGroup {
        left: Box::new(left),
        right: Box::new(right),
    };
    let body: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, left: EcPoint, right: EcPoint) -> anyhow::Result<MultiplyGroupFixture> {
    let (tree, hex) = build_tree(const_group(left), const_group(right))?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(MultiplyGroupFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn error_entry(name: &str, left: Expr, right: Expr, code: &str) -> anyhow::Result<MultiplyGroupFixture> {
    // Tree is built but sigma-rust eval is NOT run — TS test asserts only
    // the expected error code (decode_point.rs::error_entry precedent).
    let (_tree, hex) = build_throw_tree(left, right)?;
    Ok(MultiplyGroupFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<MultiplyGroupFixtureFile> {
    let mut entries = Vec::new();

    let g = generator();
    let id = identity();
    let neg_g = inverse(&g);
    // 2g = g + g — produced by sigma-rust's Mul<&EcPoint>.
    let two_g = g * &g;

    // 1. mg_gen_gen: g + g (point doubling)
    entries.push(success_entry("mg_gen_gen", g, g)?);

    // 2. mg_gen_identity: g + 0 = g
    entries.push(success_entry("mg_gen_identity", g, id)?);

    // 3. mg_identity_identity: 0 + 0 = 0
    entries.push(success_entry("mg_identity_identity", id, id)?);

    // 4. mg_distinct_points: 2g + 3g = 5g. Two DISTINCT non-trivial points (neither
    //    generator nor identity) — the only entry exercising a non-trivial ×
    //    non-trivial product, and a result (5g) no other entry produces.
    //    Previously `mg_random_random` via two `force_any_val::<EcPoint>()` draws,
    //    whose "deterministic under the proptest seed" comment was FALSE: the
    //    strategy is entropy-seeded, so the operands (which collapsed to
    //    {generator, identity}) came out in run-dependent ORDER — making
    //    multiply-group.json non-deterministic across `cargo run`s (the hash
    //    flipped every run) while duplicating mg_gen_identity. Explicit points
    //    restore determinism AND add real coverage. (iter-24 follow-up.)
    let three_g = g * &two_g; // g + 2g
    entries.push(success_entry("mg_distinct_points", two_g, three_g)?);

    // 5. mg_asymmetric: g + (-g) = 0 (curve additive inverse → identity)
    entries.push(success_entry("mg_asymmetric", g, neg_g)?);

    // 6. mg_inverse_then_doubling: 2g + (-g) = g (chain check)
    entries.push(success_entry("mg_inverse_then_doubling", two_g, neg_g)?);

    // 7. mg_throw_non_grp_left: Const(SInt, 42) left input → throw
    entries.push(error_entry(
        "mg_throw_non_grp_left",
        const_int(42),
        const_group(g),
        "group-op-input-not-group-element",
    )?);

    // 8. mg_throw_non_grp_right: Const(SInt, 42) right input → throw
    entries.push(error_entry(
        "mg_throw_non_grp_right",
        const_group(g),
        const_int(42),
        "group-op-input-not-group-element",
    )?);

    Ok(MultiplyGroupFixtureFile {
        corpus: "eval_multiply_group",
        entries,
    })
}
