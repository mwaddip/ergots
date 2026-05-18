//! SColl.zip handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/scoll.rs:138-169`
//! Method registration: `ergotree-ir/src/types/scoll.rs::ZIP_METHOD`
//!
//! Pattern B cost addPerItemCost(10, 1, 10, n) where n = obj len (NOT min).
//! Truncates to shorter Coll (Rust Iterator::zip semantics).
//! Returns Coll[STuple[T1, T2]].
//!
//! Four sub-cases (all Long-Long for simplicity; type-var binding is the exercise):
//!   - empty_zip_empty: n=0, cost base 10 + ceil(0/10)*1 = 10
//!   - equal_length: n=3, cost base 10 + ceil(3/10)*1 = 11
//!   - short_obj_long_arg: n=1 (obj shorter), cost 10 + 1 = 11
//!   - long_obj_short_arg: n=3 (obj longer), cost 10 + 1 = 11

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scoll::ZIP_METHOD;
use ergotree_ir::types::stype::SType;
use ergotree_ir::types::stype_param::STypeVar;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

/// Build one fixture entry for SColl.zip with Long obj and Long arg.
fn entry_longs(name: &str, obj: Vec<i64>, arg: Vec<i64>) -> anyhow::Result<EvalFixture> {
    let obj_const: Constant = obj.into();
    let arg_const: Constant = arg.into();
    // ZIP_METHOD uses STypeVar::t() for obj elem and STypeVar::iv() for arg elem.
    // Source: ergotree-ir/src/types/scoll.rs:103-119.
    // Both bound to SLong for Long-Long fixtures.
    let type_args = [
        (STypeVar::t(), SType::SLong),
        (STypeVar::iv(), SType::SLong),
    ]
    .iter()
    .cloned()
    .collect();
    let expr: Expr = MethodCall::new(
        obj_const.into(),
        ZIP_METHOD.clone().with_concrete_types(&type_args),
        vec![arg_const.into()],
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
        entry_longs("empty_zip_empty", vec![], vec![])?,
        entry_longs("equal_length", vec![1, 2, 3], vec![10, 20, 30])?,
        entry_longs("short_obj_long_arg", vec![1], vec![10, 20, 30])?,
        entry_longs("long_obj_short_arg", vec![1, 2, 3], vec![10])?,
    ];
    Ok(EvalFixtureFile {
        corpus: "eval_scoll_zip",
        entries,
    })
}
