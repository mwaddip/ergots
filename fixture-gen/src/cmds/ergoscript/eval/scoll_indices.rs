//! SColl.indices handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/scoll.rs:171-193`
//! Method registration: `ergotree-ir/src/types/scoll.rs::INDICES_METHOD`
//!
//! Pattern B cost addPerItemCost(20, 2, 16, n). Returns Coll[Int] = 0..n-1.
//!
//! Three sub-cases:
//!   - empty collection (n=0): base cost 20, no per-chunk charge
//!   - three elements (n=3): one chunk (ceil(3/16)=1), cost 20 + 2 = 22
//!   - seventeen elements (n=17): two chunks (ceil(17/16)=2), cost 20 + 4 = 24

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scoll::INDICES_METHOD;
use ergotree_ir::types::stype::SType;
use ergotree_ir::types::stype_param::STypeVar;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

/// Build one fixture entry for SColl.indices with the given i64 input items.
fn entry(name: &str, items: Vec<i64>) -> anyhow::Result<EvalFixture> {
    let coll_const: Constant = items.into();
    let expr: Expr = MethodCall::new(
        coll_const.into(),
        INDICES_METHOD
            .clone()
            .with_concrete_types(&[(STypeVar::t(), SType::SLong)].iter().cloned().collect()),
        vec![],
    )?
    .into();

    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let entries = vec![
        entry("empty", vec![])?,
        entry("three_elements", vec![10, 20, 30])?,
        entry("seventeen_elements_two_chunks", (0..17).collect())?,
    ];
    Ok(EvalFixtureFile {
        corpus: "eval_scoll_indices",
        entries,
    })
}
