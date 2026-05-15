//! And arm — fixtures for `Expr::And(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/and.rs:11-22`
//!   let input_v = self.input.eval(env, ctx)?;
//!   let input_v_bools = input_v.try_extract_into::<Vec<bool>>()?;
//!   ctx.add_per_item_jit_cost(10, 5, 32, input_v_bools.len() as u32)?;
//!   Ok(input_v_bools.iter().all(|b| *b).into())
//!
//! Cost ordering: envelope charged AFTER eval-child. The cost depends on
//! the runtime length of the resulting collection (Cast pattern from 2d-A).
//!
//! Empty-Coll behavior: `And([]) → true` (Rust `iter().all` returns true
//! on empty; matches JS `Array.prototype.every`).
//!
//! Coverage:
//!   - Empty Coll[Boolean] → true (n=0, vacuous truth).
//!   - Single-item [true] / [false].
//!   - All-true at varied lengths.
//!   - All-false at varied lengths.
//!   - Mixed with one false (And short-fail).
//!   - n=32 (exactly one chunk per `chunkSize=32`).
//!   - n=33 (one full + one partial chunk; chunk-boundary).
//!   - 1 cost-limit entry (`jitCostLimit` < base cost) → `'cost-limit-exceeded'`.
//!
//! Non-Coll[Boolean] error case is NOT generated here. `And::sigma_parse`
//! requires `post_eval_tpe == Coll[Boolean]` on the input, so we cannot
//! serialize a malformed tree through the standard path. The TS-side
//! `'coll-not-boolean'` assertion is covered by inline tests that
//! construct hand-built MIR nodes (LogicalNot / 2d-A precedent).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::and::And;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::constant::Literal;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::CollKind;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;
use std::sync::Arc;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct AndFixture {
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
pub struct AndFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<AndFixture>,
}

/// Wrap a `Vec<bool>` into a `Const(Coll[Boolean])` Expr.
fn bool_coll_const(bools: Vec<bool>) -> Expr {
    let literals: Arc<[Literal]> = bools.into_iter().map(Literal::from).collect();
    let coll = CollKind::from_collection(SType::SBoolean, literals)
        .expect("from_collection on SBoolean");
    Expr::Const(Constant {
        tpe: SType::SColl(SType::SBoolean.into()),
        v: Literal::Coll(coll),
    })
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    // And::sigma_parse takes a single Expr and validates post_eval_tpe ==
    // Coll[Boolean]. We construct directly via the struct (the parser-side
    // invariant is the same precondition our parser will enforce).
    let expr: Expr = And {
        input: Box::new(input),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, bools: Vec<bool>) -> anyhow::Result<AndFixture> {
    let input = bool_coll_const(bools);
    let (tree, hex) = build_tree(input)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(AndFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Cost-limit entry — `jitCostLimit` set below the per-arm cost so
/// `addCost` overshoots when the cost is finally charged. Sigma-rust
/// path raises `CostLimitExceeded`; TS-side throws `'cost-limit-exceeded'`.
fn cost_limit_entry(name: &str, bools: Vec<bool>, limit: u64) -> anyhow::Result<AndFixture> {
    let input = bool_coll_const(bools);
    let (_tree, hex) = build_tree(input)?;
    Ok(AndFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<AndFixtureFile> {
    let mut entries = Vec::new();

    // Empty Coll → vacuous truth.
    entries.push(success_entry("and_empty", vec![])?);

    // Single-item.
    entries.push(success_entry("and_single_true", vec![true])?);
    entries.push(success_entry("and_single_false", vec![false])?);

    // All-true at small + medium lengths.
    entries.push(success_entry("and_all_true_3", vec![true; 3])?);
    entries.push(success_entry("and_all_true_10", vec![true; 10])?);

    // All-false.
    entries.push(success_entry("and_all_false_3", vec![false; 3])?);

    // Mixed: one false breaks the chain.
    entries.push(success_entry(
        "and_mixed_one_false",
        vec![true, true, false, true],
    )?);

    // Chunk boundaries: n=32 (exactly one chunk per chunkSize=32);
    // n=33 (one full + one partial chunk — locks the chunking math).
    entries.push(success_entry("and_n32_all_true", vec![true; 32])?);
    entries.push(success_entry("and_n33_all_true", vec![true; 33])?);

    // Cost-limit: 1 < base cost of 10 — overshoots immediately.
    entries.push(cost_limit_entry("and_cost_limit_exceeded", vec![true; 3], 1)?);

    Ok(AndFixtureFile {
        corpus: "eval_and",
        entries,
    })
}
