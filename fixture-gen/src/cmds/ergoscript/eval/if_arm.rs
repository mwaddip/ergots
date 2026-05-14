//! If arm — fixtures for `Expr::If(...)` evaluation.
//! Sigma-rust ref: ergotree-interpreter/src/eval/if_op.rs:16
//! Cost: If = Fixed(10) + condition eval cost + ONLY taken branch's cost.
//! Short-circuit: non-taken branch is never evaluated.
//! Uses test_util.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::if_op::If;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    for (name, cond_val, t_val, f_val) in [
        ("if_true_branch", true, 1i32, 2i32),
        ("if_false_branch", false, 1i32, 2i32),
    ] {
        let if_expr: Expr = If {
            condition: Expr::Const(cond_val.into()).into(),
            true_branch: Expr::Const(t_val.into()).into(),
            false_branch: Expr::Const(f_val.into()).into(),
        }
        .into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &if_expr)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        entries.push(EvalFixture {
            name: name.to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_if",
        entries,
    })
}
