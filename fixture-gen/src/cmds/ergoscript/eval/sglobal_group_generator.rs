//! SGlobal.groupGenerator handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/sglobal.rs:32-41`
//! Method registration: `ergotree-ir/src/types/sglobal.rs::GROUP_GENERATOR_METHOD`
//!
//! Pattern A cost 10. Returns the 33-byte SEC1 compressed secp256k1 base
//! point. Tree shape: PropertyCall(Global, groupGenerator).
//!
//! Total eval cost: 4 (PropertyCall dispatcher) + 5 (Global arm) + 10 (handler) = 19.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::sglobal::GROUP_GENERATOR_METHOD;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Single case: PropertyCall(Global, groupGenerator) wrapped in a v0 ErgoTree.
    // Expected value: GroupElement (33-byte SEC1 compressed secp256k1 base point).
    // Expected cost: 4 (dispatcher) + 5 (Global arm) + 10 (handler) = 19.
    let expr: Expr = PropertyCall::new(Expr::Global, GROUP_GENERATOR_METHOD.clone())
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    entries.push(EvalFixture {
        name: "global_group_generator".to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_sglobal_group_generator",
        entries,
    })
}
