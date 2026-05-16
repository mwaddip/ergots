//! CreateProveDlog C1 fixture (phase 2g-medium Task 3).
//!
//! Entries:
//!   - basic: ProveDlog from a deterministic GroupElement constant; cost = 15
//!     (10 arm envelope + 5 Const child).
//!   - identity-point: ProveDlog from the 33-zero-byte identity (Ergo convention).
//!   - cost-limit-exceeded: tight jitCostLimit triggers 'cost-limit-exceeded'.
//!
//! Source: ergotree-interpreter/src/eval/create_provedlog.rs:10-29
//!   ctx.add_jit_cost(10)?;  // CreateProveDlog = Fixed(10); Pattern A (before child eval)
//!   match value { Value::GroupElement(ecpoint) => ProveDlog::new(*ecpoint).into() }

use ergo_chain_types::ec_point::{generator, identity};
use ergo_chain_types::EcPoint;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::create_provedlog::CreateProveDlog;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

#[derive(Serialize)]
pub struct CreateProveDlogEntry {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for error entries
    pub expected_value_json: JsonValue,
    /// 0 for error entries
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct CreateProveDlogFixture {
    pub description: &'static str,
    pub entries: Vec<CreateProveDlogEntry>,
}

/// Encode a SigmaBoolean (ProveDlog) as `{ kind: "SigmaProp", raw_hex: "..." }`.
/// raw_hex = sigma_serialize_bytes() of the SigmaBoolean directly (NOT ErgoTree prop_bytes).
/// The TS hydrateSValue SigmaProp arm calls parseSigmaBoolean(ByteReader(raw_hex_bytes)).
fn sigma_prop_value_to_json(val: &Value) -> anyhow::Result<JsonValue> {
    if let Value::SigmaProp(sp) = val {
        let raw_bytes = sp.value().sigma_serialize_bytes()?;
        Ok(json!({ "kind": "SigmaProp", "raw_hex": hex::encode(&raw_bytes) }))
    } else {
        anyhow::bail!("expected SigmaProp, got {:?}", val)
    }
}

fn build_tree(ec_point: EcPoint) -> anyhow::Result<(ErgoTree, String)> {
    // Constant { tpe: SGroupElement, v: Literal::GroupElement(Arc::new(ec_point)) }
    // From<EcPoint> for Constant is implemented in sigma-rust.
    let ge_const: ergotree_ir::mir::constant::Constant = ec_point.into();
    let input_expr: Expr = ge_const.into();
    let body: Expr = CreateProveDlog::try_build(input_expr)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, ec_point: EcPoint) -> anyhow::Result<CreateProveDlogEntry> {
    let (tree, hex) = build_tree(ec_point)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let expected_value_json = sigma_prop_value_to_json(&val)?;
    Ok(CreateProveDlogEntry {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json,
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn cost_limit_entry(
    name: &str,
    ec_point: EcPoint,
    limit: u64,
) -> anyhow::Result<CreateProveDlogEntry> {
    let (_tree, hex) = build_tree(ec_point)?;
    Ok(CreateProveDlogEntry {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<CreateProveDlogFixture> {
    // basic: secp256k1 generator G (a concrete non-identity compressed point)
    // ergo-chain-types/src/ec_point.rs:92-94
    let pk_basic = generator();
    // identity-point: Ergo identity = 33 zero bytes (ergo-chain-types/src/ec_point.rs:96-99)
    let pk_identity = identity();

    let mut entries = Vec::new();

    entries.push(success_entry("basic", pk_basic)?);
    entries.push(success_entry("identity-point", pk_identity)?);
    // cost-limit-exceeded: jitCostLimit=5 < arm envelope of 10; reuse generator as tree input
    entries.push(cost_limit_entry("cost-limit-exceeded", generator(), 5)?);

    Ok(CreateProveDlogFixture {
        description: "CreateProveDlog C1 fixture — wraps a GroupElement Const into SigmaProp{ProveDlog, h}. Pattern A cost Fixed(10) before child eval.",
        entries,
    })
}
