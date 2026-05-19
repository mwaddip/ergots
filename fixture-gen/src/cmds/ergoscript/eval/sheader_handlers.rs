//! SHeader property accessor handlers — all 15 fixtures in one module.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/sheader.rs:16-113`
//! Method registration: `ergotree-ir/src/types/sheader.rs`
//!
//! All 15 handlers follow Pattern A Fixed(10): ctx.add_jit_cost(10) before
//! field projection.
//!
//! Total eval cost per entry: 4 (outer PropertyCall dispatcher)
//!                           + 4 (ByIndex arm dispatcher)
//!                           + 1 (Const arm — index literal 0)
//!                           + 4 (inner PropertyCall dispatcher — Context.headers)
//!                           + 1 (Context arm)
//!                           + 15 (SContext.headers handler)
//!                           + 10 (SHeader.<property> handler)
//!                           = 39
//!
//! Tree structure: PropertyCall(ByIndex(PropertyCall(Context, headers), Const(0)), <method>)

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::coll_by_index::ByIndex;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scontext::HEADERS_PROPERTY;
use ergotree_ir::types::sheader::{
    AD_PROOFS_ROOT_PROPERTY, EXTENSION_ROOT_PROPERTY, HEIGHT_PROPERTY, ID_PROPERTY,
    MINER_PK_PROPERTY, N_BITS_PROPERTY, PARENT_ID_PROPERTY, POW_DISTANCE_PROPERTY,
    POW_NONCE_PROPERTY, POW_ONETIME_PK_PROPERTY, STATE_ROOT_PROPERTY, TIMESTAMP_PROPERTY,
    TRANSACTIONS_ROOT_PROPERTY, VERSION_PROPERTY, VOTES_PROPERTY,
};
use proptest::arbitrary::Arbitrary;
use proptest::strategy::Strategy;
use proptest::test_runner::TestRunner;
use serde_json::json;

use super::common::{headers_to_json, value_to_json, EvalFixture, EvalFixtureFile};

/// Build the Expr tree: `PropertyCall(ByIndex(PropertyCall(Context, headers), Const(0i32)), method)`.
fn header_property_expr(
    method: ergotree_ir::types::smethod::SMethod,
) -> anyhow::Result<Expr> {
    let headers_expr: Expr = PropertyCall::new(Expr::Context, HEADERS_PROPERTY.clone())
        .map_err(|e| anyhow::anyhow!("PropertyCall Context.headers: {:?}", e))?
        .into();
    let header_expr: Expr = ByIndex::new(headers_expr, Expr::Const(0i32.into()), None)
        .map_err(|e| anyhow::anyhow!("ByIndex headers[0]: {:?}", e))?
        .into();
    let expr: Expr = PropertyCall::new(header_expr, method)
        .map_err(|e| anyhow::anyhow!("PropertyCall header.<method>: {:?}", e))?
        .into();
    Ok(expr)
}


/// Create one fixture entry: build a fresh deterministic Context, evaluate the
/// method property accessor on headers[0], capture expected value + cost.
fn make_entry(
    method: ergotree_ir::types::smethod::SMethod,
    entry_name: &str,
) -> anyhow::Result<EvalFixture> {
    // Each entry gets its own deterministic Context (same data, jit_cost starts at 0).
    let mut runner = TestRunner::deterministic();
    let ctx = Context::arbitrary().new_tree(&mut runner).unwrap().current();
    let expr = header_property_expr(method)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();
    let opts_json = json!({
        "headers": headers_to_json(&ctx.headers),
    });
    Ok(EvalFixture {
        name: entry_name.to_string(),
        tree_bytes_hex,
        opts_json,
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    entries.push(make_entry(ID_PROPERTY.clone(), "header_id")?);
    entries.push(make_entry(VERSION_PROPERTY.clone(), "header_version")?);
    entries.push(make_entry(PARENT_ID_PROPERTY.clone(), "header_parent_id")?);
    entries.push(make_entry(AD_PROOFS_ROOT_PROPERTY.clone(), "header_ad_proofs_root")?);
    entries.push(make_entry(STATE_ROOT_PROPERTY.clone(), "header_state_root")?);
    entries.push(make_entry(TRANSACTIONS_ROOT_PROPERTY.clone(), "header_transactions_root")?);
    entries.push(make_entry(TIMESTAMP_PROPERTY.clone(), "header_timestamp")?);
    entries.push(make_entry(N_BITS_PROPERTY.clone(), "header_n_bits")?);
    entries.push(make_entry(HEIGHT_PROPERTY.clone(), "header_height")?);
    entries.push(make_entry(EXTENSION_ROOT_PROPERTY.clone(), "header_extension_root")?);
    entries.push(make_entry(MINER_PK_PROPERTY.clone(), "header_miner_pk")?);
    entries.push(make_entry(POW_ONETIME_PK_PROPERTY.clone(), "header_pow_onetime_pk")?);
    entries.push(make_entry(POW_NONCE_PROPERTY.clone(), "header_pow_nonce")?);
    entries.push(make_entry(POW_DISTANCE_PROPERTY.clone(), "header_pow_distance")?);
    entries.push(make_entry(VOTES_PROPERTY.clone(), "header_votes")?);

    Ok(EvalFixtureFile {
        corpus: "eval_sheader_handlers",
        entries,
    })
}
