//! ConstPlaceholder arm — fixtures for `Expr::ConstPlaceholder(cp)` evaluation.
//!
//! These trees use constant segregation: the body is a ConstPlaceholder
//! that references the tree.constants[id]. Cost: ConstantPlaceholder = Fixed(1).
//!
//! Uses test_util (gated by 'arbitrary' feature on ergotree-interpreter).
//!
//! NB: We deliberately use `tree.root_expr()` + `ctx.with_constants(...)`
//! rather than `tree.proposition()`. `proposition()` calls
//! `root.substitute_constants(&tree.constants)` which RESOLVES every
//! `ConstantPlaceholder` into its `Constant` BEFORE evaluation — that would
//! make the oracle exercise the `Expr::Const` arm (cost 5), not the
//! `Expr::ConstPlaceholder` arm we're trying to characterize (cost 1).
//! Sigma-rust's lazy-constants path (`eval.rs:259-261`) shows the correct
//! pattern: hand the unsubstituted root to the evaluator, attach the
//! constants table to the context, let the ConstPlaceholder arm look them
//! up on demand.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    let cases: Vec<(&str, Constant)> = vec![
        ("placeholder_int_42", 42i32.into()),
        ("placeholder_long_max", i64::MAX.into()),
        ("placeholder_bool_true", true.into()),
        ("placeholder_byte_neg1", (-1i8).into()),
    ];

    for (name, c) in cases {
        // ErgoTree::new with v0+segregation auto-extracts the Const into
        // tree.constants and replaces body with a ConstantPlaceholder.
        let header = ergotree_ir::ergo_tree::ErgoTreeHeader::v0(true);
        let expr: Expr = c.clone().into();
        let tree = ErgoTree::new(header, &expr)?;
        let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

        // Use the unsubstituted root (still ConstantPlaceholder) and attach
        // the constants table to the context for lazy resolution. See module
        // docs for why `proposition()` is wrong here.
        let base_ctx = force_any_val::<Context>();
        let constants = tree.constants()?;
        let ctx = base_ctx.with_constants(constants);
        let root = tree.root_expr()?.clone();
        let val: Value<'static> = try_eval_out(&root, &ctx)?;
        let cost = ctx.jit_cost_value();

        entries.push(EvalFixture {
            name: name.to_string(),
            tree_bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: cost,
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_const_placeholder",
        entries,
    })
}
