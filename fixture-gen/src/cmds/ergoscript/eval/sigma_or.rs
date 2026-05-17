//! SigmaOr eval arm fixture (phase 2g-combinators Task 6).
//!
//! SigmaOr is the OR sigma combinator: `SigmaOr { items: SigmaConjectureItems<Expr> }` —
//! each item is an Expr that evaluates to SSigmaProp, then combined via `corNormalized`.
//!
//! Cost: Pattern A — `add_per_item_jit_cost(10, 2, 1, n)` BEFORE eval-children.
//!   Source: ergotree-interpreter/src/eval/sigma_or.rs:19
//!
//! Eval flow:
//!   1. charge per-item cost (base=10, perChunk=2, chunkSize=1, n=items.len())
//!   2. eval each item (sequential, try_mapped_ref) → must each be SigmaProp
//!   3. extract SigmaBoolean from each SigmaProp
//!   4. corNormalized(items) — TrivialProp(false) absorbed (identity), TrivialProp(true) absorbing
//!
//! Coverage:
//!   - 2-leaf ProveDlogs → Cor([P,Q])
//!   - 3-leaf ProveDlogs → Cor([P,Q,R])
//!   - 5-leaf ProveDlogs → Cor([P,Q,R,S,T])
//!   - TrivialProp(false) child absorbed → Cor([P,Q]) (identity element for OR)
//!   - TrivialProp(true) child → TrivialProp(true) (absorbing element for OR)
//!   - single child after normalization → unwrapped ProveDlog (Cor([X]) → X)
//!   - empty after normalization → TrivialProp(false) (all-false → false)
//!   - mixed ProveDlog + DhTuple leaves
//!   - cost-limit-exceeded (tight limit below base cost)

use ergo_chain_types::ec_point::generator;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::{Constant, Literal};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::sigma_or::SigmaOr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDhTuple, ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp,
};
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

/// Build a ProveDlog from the secp256k1 generator point. Deterministic.
fn prove_dlog() -> SigmaBoolean {
    let pt = generator();
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(pt)))
}

/// Build a ProveDhTuple from secp256k1 generator used for all four points.
/// Not a valid DH tuple cryptographically, but structurally valid for eval tests.
fn prove_dh_tuple() -> SigmaBoolean {
    let pt = generator();
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(ProveDhTuple::new(
        pt.clone(),
        pt.clone(),
        pt.clone(),
        pt,
    )))
}

fn trivial_true() -> SigmaBoolean {
    SigmaBoolean::TrivialProp(true)
}

fn trivial_false() -> SigmaBoolean {
    SigmaBoolean::TrivialProp(false)
}

/// Build a Const(SSigmaProp, sb) expression.
fn sigma_prop_const(sb: SigmaBoolean) -> Expr {
    let sp = SigmaProp::new(sb);
    Expr::Const(Constant {
        tpe: SType::SSigmaProp,
        v: Literal::SigmaProp(Box::new(sp)),
    })
}

/// Build a SigmaOr ErgoTree from sigma-boolean items and return (tree, hex).
fn build_tree(items: Vec<SigmaBoolean>) -> anyhow::Result<(ErgoTree, String)> {
    let exprs: Vec<Expr> = items.into_iter().map(sigma_prop_const).collect();
    let body: Expr = SigmaOr::new(exprs)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Encode a sigma-rust Value::SigmaProp as `{ kind: "SigmaProp", raw_hex: "..." }`.
/// raw_hex = sigma_serialize_bytes of the inner SigmaBoolean.
/// Matches the TS hydrateSValue SigmaProp arm which calls parseSigmaBoolean(bytes).
fn sigma_prop_value_to_json(val: &Value) -> anyhow::Result<JsonValue> {
    if let Value::SigmaProp(sp) = val {
        let raw_bytes = sp.value().sigma_serialize_bytes()?;
        Ok(json!({ "kind": "SigmaProp", "raw_hex": hex::encode(&raw_bytes) }))
    } else {
        anyhow::bail!("expected SigmaProp, got {:?}", val)
    }
}

#[derive(Serialize)]
pub struct SigmaOrEntry {
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
pub struct SigmaOrFixture {
    pub description: &'static str,
    pub entries: Vec<SigmaOrEntry>,
}

fn success_entry(name: &str, items: Vec<SigmaBoolean>) -> anyhow::Result<SigmaOrEntry> {
    let (tree, hex) = build_tree(items)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let expected_value_json = sigma_prop_value_to_json(&val)?;
    Ok(SigmaOrEntry {
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
    items: Vec<SigmaBoolean>,
    limit: u64,
) -> anyhow::Result<SigmaOrEntry> {
    let (_tree, hex) = build_tree(items)?;
    Ok(SigmaOrEntry {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<SigmaOrFixture> {
    let mut entries = Vec::new();

    let p = prove_dlog();
    let q = prove_dlog();
    let r = prove_dlog();
    let s = prove_dlog();
    let t = prove_dlog();
    let dh = prove_dh_tuple();

    // 2-leaf basic: Cor([P,Q])
    entries.push(success_entry(
        "sigma_or_2_leaf",
        vec![p.clone(), q.clone()],
    )?);

    // 3-leaf basic: Cor([P,Q,R])
    entries.push(success_entry(
        "sigma_or_3_leaf",
        vec![p.clone(), q.clone(), r.clone()],
    )?);

    // 5-leaf basic: Cor([P,Q,R,S,T])
    entries.push(success_entry(
        "sigma_or_5_leaf",
        vec![p.clone(), q.clone(), r.clone(), s.clone(), t.clone()],
    )?);

    // TrivialProp(false) absorbed (identity for OR): [F,P,Q] → Cor([P,Q])
    entries.push(success_entry(
        "sigma_or_false_absorbed",
        vec![trivial_false(), p.clone(), q.clone()],
    )?);

    // TrivialProp(true) absorbing for OR: [T,P,Q] → TrivialProp(true)
    entries.push(success_entry(
        "sigma_or_true_absorbing",
        vec![trivial_true(), p.clone(), q.clone()],
    )?);

    // Single real child after normalization: [F,P] → P (unwrapped)
    entries.push(success_entry(
        "sigma_or_single_after_filter",
        vec![trivial_false(), p.clone()],
    )?);

    // Empty after normalization: [F,F] → TrivialProp(false)
    entries.push(success_entry(
        "sigma_or_empty_after_filter",
        vec![trivial_false(), trivial_false()],
    )?);

    // Mixed ProveDlog + DhTuple
    entries.push(success_entry(
        "sigma_or_mixed_dlog_dhtuple",
        vec![p.clone(), dh.clone()],
    )?);

    // Cost-limit-exceeded: Pattern A — cost is charged first, before eval.
    // addPerItemCost(10, 2, 1, 2) = 10 + ceil(2/1)*2 = 10 + 4 = 14 (base estimate).
    // Actual cost from sigma-rust will include tree overhead. Limit=1 → always triggers.
    entries.push(cost_limit_entry(
        "sigma_or_cost_limit_exceeded",
        vec![p.clone(), q.clone()],
        1,
    )?);

    Ok(SigmaOrFixture {
        description: "SigmaOr eval arm (phase 2g-combinators Task 6). Pattern A cost: addPerItemCost(10, 2, 1, n) BEFORE eval-children. Source: ergotree-interpreter/src/eval/sigma_or.rs. Absorbing/identity SWAPPED vs SigmaAnd: TrivialProp(true) absorbing, TrivialProp(false) identity.",
        entries,
    })
}
