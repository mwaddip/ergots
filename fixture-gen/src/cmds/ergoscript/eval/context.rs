//! Context arm — fixtures for `Expr::Context` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/expr.rs:41-44`
//!   Expr::Context => {
//!       ctx.add_jit_cost(1)?;   // Context = Fixed(1)
//!       Ok(Value::Context)
//!   }
//!
//! Trivial arm: cost 1 (Pattern A — single fixed cost before returning
//! sentinel). No child expressions. Returns `Value::Context`, the opaque
//! runtime handle consumed by method-call handlers (Task 5: SContext.dataInputs).
//!
//! Single fixture entry: tree = ErgoTree wrapping bare `Expr::Context`.
//! Expected value: `{ "kind": "Context" }`. Expected cost: 1.

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

    // Single case: bare `Expr::Context` wrapped in a v0 ErgoTree (no
    // constant segregation needed — Context has no child expressions).
    let expr: Expr = Expr::Context;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    entries.push(EvalFixture {
        name: "context_sentinel".to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_context",
        entries,
    })
}
