//! LogicalNot arm — fixtures for `Expr::LogicalNot(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/logical_not.rs:16`
//!   ctx.add_jit_cost(15)?;  // LogicalNot = Fixed(15)
//!   let input_v = self.input.eval(env, ctx)?;
//!   let input_v_bool = input_v.try_extract_into::<bool>()?;
//!   Ok((!input_v_bool).into())
//!
//! Cost: Fixed(15) (arm envelope) + input cost (Const = 5) = 20 total.
//! Two truth-table entries: !true → false, !false → true.
//!
//! Uses test_util (gated by 'arbitrary' feature on ergotree-interpreter)
//! to drive the same evaluator the Scala node ships with — sigma-rust IS
//! the cost+value oracle for this arm.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::logical_not::LogicalNot;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    for (name, input_val) in [("logical_not_true", true), ("logical_not_false", false)] {
        let input_expr: Expr = Expr::Const(input_val.into());
        let not_expr: Expr = LogicalNot::try_build(input_expr)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &not_expr)?;
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
        corpus: "eval_logical_not",
        entries,
    })
}
