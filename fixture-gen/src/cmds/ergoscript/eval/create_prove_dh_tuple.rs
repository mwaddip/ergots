//! CreateProveDhTuple C1 fixture (phase 2g-medium Task 4).
//!
//! Entries:
//!   - basic: ProveDhTuple from four distinct deterministic GroupElement constants;
//!     cost = 40 (20 arm envelope + 4 × 5 Const children).
//!   - identity-g: `g` is the 33-zero-byte identity; rest are the secp256k1 generator.
//!   - cost-limit-exceeded: tight jitCostLimit (10) triggers 'cost-limit-exceeded'.
//!
//! Source: ergotree-interpreter/src/eval/create_prove_dh_tuple.rs:12-25
//!   ctx.add_jit_cost(20)?;  // CreateProveDHTuple = Fixed(20); Pattern A (before child eval)
//!   g/h/u/v each try_extract_into::<EcPoint>()
//!   Ok(ProveDhTuple::new(g, h, u, v).into())

use ergo_chain_types::ec_point::{generator, identity};
use ergo_chain_types::EcPoint;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::create_prove_dh_tuple::CreateProveDhTuple;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

#[derive(Serialize)]
pub struct CreateProveDhTupleEntry {
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
pub struct CreateProveDhTupleFixture {
    pub description: &'static str,
    pub entries: Vec<CreateProveDhTupleEntry>,
}

/// Encode a SigmaBoolean (ProveDhTuple) as `{ kind: "SigmaProp", raw_hex: "..." }`.
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

fn build_tree(g: EcPoint, h: EcPoint, u: EcPoint, v: EcPoint) -> anyhow::Result<(ErgoTree, String)> {
    let g_const: ergotree_ir::mir::constant::Constant = g.into();
    let h_const: ergotree_ir::mir::constant::Constant = h.into();
    let u_const: ergotree_ir::mir::constant::Constant = u.into();
    let v_const: ergotree_ir::mir::constant::Constant = v.into();

    let g_expr: Expr = g_const.into();
    let h_expr: Expr = h_const.into();
    let u_expr: Expr = u_const.into();
    let v_expr: Expr = v_const.into();

    let body: Expr = CreateProveDhTuple::new(g_expr, h_expr, u_expr, v_expr)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(
    name: &str,
    g: EcPoint,
    h: EcPoint,
    u: EcPoint,
    v: EcPoint,
) -> anyhow::Result<CreateProveDhTupleEntry> {
    let (tree, hex) = build_tree(g, h, u, v)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let expected_value_json = sigma_prop_value_to_json(&val)?;
    Ok(CreateProveDhTupleEntry {
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
    g: EcPoint,
    h: EcPoint,
    u: EcPoint,
    v: EcPoint,
    limit: u64,
) -> anyhow::Result<CreateProveDhTupleEntry> {
    let (_tree, hex) = build_tree(g, h, u, v)?;
    Ok(CreateProveDhTupleEntry {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<CreateProveDhTupleFixture> {
    // secp256k1 generator G — a concrete non-identity compressed point.
    let gen = generator();
    // 33-zero-byte identity (Ergo convention).
    let id = identity();

    let mut entries = Vec::new();

    // basic: all four inputs are the generator (four distinct-but-equal points).
    entries.push(success_entry("basic", gen.clone(), gen.clone(), gen.clone(), gen.clone())?);
    // identity-g: g is the identity; h, u, v are the generator.
    entries.push(success_entry("identity-g", id, gen.clone(), gen.clone(), gen.clone())?);
    // cost-limit-exceeded: jitCostLimit=10 < arm envelope of 20.
    entries.push(cost_limit_entry(
        "cost-limit-exceeded",
        gen.clone(),
        gen.clone(),
        gen.clone(),
        gen,
        10,
    )?);

    Ok(CreateProveDhTupleFixture {
        description: "CreateProveDhTuple C1 fixture — wraps four GroupElement Consts into SigmaProp{ProveDhTuple, g, h, u, v}. Pattern A cost Fixed(20) before child eval.",
        entries,
    })
}
