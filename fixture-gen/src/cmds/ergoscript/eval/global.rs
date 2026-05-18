//! Global arm — fixtures for `Expr::Global` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/expr.rs:37-40`
//!   Expr::Global => {
//!       ctx.add_jit_cost(5)?;   // Global = Fixed(5)
//!       Ok(Value::Global)
//!   }
//!
//! Trivial arm: cost 5 (Pattern A). No child expressions. Returns
//! `Value::Global`, the opaque runtime handle consumed by `SGlobal.*`
//! method-call handlers (Task 2: groupGenerator).
//!
//! Single fixture entry: tree = ErgoTree wrapping bare `Expr::Global`.
//! Expected value: `{ "kind": "Global" }`. Expected cost: 5.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Single case: bare `Expr::Global` wrapped in a v0 ErgoTree (no
    // constant segregation needed — Global has no child expressions).
    let expr: Expr = Expr::Global;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    entries.push(EvalFixture {
        name: "global_sentinel".to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_global",
        entries,
    })
}
