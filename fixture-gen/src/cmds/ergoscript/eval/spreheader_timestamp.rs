//! SPreHeader.timestamp handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/spreheader.rs:20-24`
//! Method registration: `ergotree-ir/src/types/spreheader.rs::TIMESTAMP_PROPERTY`
//!
//! Pattern A cost 10. Returns Long.
//!
//! Total eval cost: 4 (outer PropertyCall dispatcher) + 4 (inner PropertyCall dispatcher)
//! + 1 (Context arm) + 15 (preHeader handler) + 10 (timestamp handler) = 34.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scontext::PRE_HEADER_PROPERTY;
use ergotree_ir::types::spreheader::TIMESTAMP_PROPERTY;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{preheader_to_json, value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Tree: PropertyCall(PropertyCall(Context, preHeader), timestamp)
    // Outer: typeId=105 (SPreHeader), methodId=3 (timestamp)
    // Inner: typeId=101 (SContext), methodId=3 (preHeader)
    let pre_header_expr: Expr = PropertyCall::new(Expr::Context, PRE_HEADER_PROPERTY.clone())
        .unwrap()
        .into();
    let expr: Expr = PropertyCall::new(pre_header_expr, TIMESTAMP_PROPERTY.clone())
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    let opts_json = json!({
        "preHeader": preheader_to_json(&ctx.pre_header),
    });

    entries.push(EvalFixture {
        name: "context_pre_header_timestamp".to_string(),
        tree_bytes_hex,
        opts_json,
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_spreheader_timestamp",
        entries,
    })
}
