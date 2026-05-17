//! `SigmaPropBytes` C1 fixtures (phase 2g.5 Task 2).
//!
//! Covers the full SigmaBoolean surface for prop_bytes serialization:
//!   TrivialProp(true), TrivialProp(false), ProveDlog, Cand(2-leaf), Cor(2-leaf).
//!
//! Cost: Pattern A — `add_per_item_jit_cost(35, 6, 1, 1)` BEFORE eval-children.
//! Source: ergotree-interpreter/src/eval/sigma_prop_bytes.rs:15
//!
//! Each entry:
//!   - wraps a `SigmaBoolean` as `Const(SSigmaProp, ...)` → `SigmaPropBytes { input }`
//!   - serializes the outer `SigmaPropBytes` expr as an ErgoTree
//!   - runs `try_eval_out` against a synthetic Context to get expected value + cost
//!   - expected_value is `Coll[Byte]` (sigma-rust NativeColl::CollByte unpacked to items)

use ergo_chain_types::ec_point::generator;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::{Constant, Literal};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::sigma_prop_bytes::SigmaPropBytes;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp,
};
use ergotree_ir::sigma_protocol::sigma_boolean::cand::Cand;
use ergotree_ir::sigma_protocol::sigma_boolean::cor::Cor;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

/// Build a ProveDlog from the secp256k1 generator point. Deterministic.
fn prove_dlog() -> SigmaBoolean {
    let pt = generator();
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(pt)))
}

/// Build a Const(SSigmaProp, sb) expression.
fn sigma_prop_const(sb: SigmaBoolean) -> Expr {
    let sp = SigmaProp::new(sb);
    Expr::Const(Constant {
        tpe: SType::SSigmaProp,
        v: Literal::SigmaProp(Box::new(sp)),
    })
}

/// Encode a Coll[Byte] result (NativeColl::CollByte) as fixture JSON.
/// sigma-rust's value_to_json unpacks NativeColl::CollByte to items array;
/// we mirror that here so the TS hydrateSValue is consistent.
fn coll_byte_to_json(bytes: &[i8]) -> JsonValue {
    let items: Vec<JsonValue> = bytes
        .iter()
        .map(|b| json!({ "kind": "Byte", "value": *b as i32 }))
        .collect();
    json!({
        "kind": "Coll",
        "elem": { "tag": "SByte" },
        "items": items,
    })
}

#[derive(Serialize)]
pub struct SigmaPropBytesEntry {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    pub expected_value_json: JsonValue,
    pub expected_cost: u64,
}

#[derive(Serialize)]
pub struct SigmaPropBytesFixture {
    pub description: &'static str,
    pub entries: Vec<SigmaPropBytesEntry>,
}

fn entry(name: &str, sb: SigmaBoolean) -> anyhow::Result<SigmaPropBytesEntry> {
    let input_expr = sigma_prop_const(sb);
    let body: Expr = SigmaPropBytes {
        input: Box::new(input_expr),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> =
        try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    // Extract the byte slice from the Coll[Byte] result.
    let expected_value_json = match &val {
        ergotree_ir::mir::value::Value::Coll(coll_kind) => {
            use ergotree_ir::mir::value::{CollKind, NativeColl};
            match coll_kind {
                CollKind::NativeColl(NativeColl::CollByte(bytes)) => coll_byte_to_json(bytes),
                _ => anyhow::bail!("SigmaPropBytes eval: expected NativeColl::CollByte, got {:?}", val),
            }
        }
        _ => anyhow::bail!("SigmaPropBytes eval: expected Coll, got {:?}", val),
    };

    Ok(SigmaPropBytesEntry {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json,
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<SigmaPropBytesFixture> {
    let p = prove_dlog();
    let q = prove_dlog();

    // Cand::normalized and Cor::normalized take SigmaConjectureItems<SigmaBoolean>
    // which is BoundedVec<SigmaBoolean, 1, 255>. Use .try_into().unwrap() to convert Vec.
    // Both functions return SigmaBoolean directly (not Result).
    let cand_2 = Cand::normalized(vec![p.clone(), q.clone()].try_into().unwrap());
    let cor_2 = Cor::normalized(vec![p.clone(), q.clone()].try_into().unwrap());

    let entries = vec![
        entry("trivial_true", SigmaBoolean::TrivialProp(true))?,
        entry("trivial_false", SigmaBoolean::TrivialProp(false))?,
        entry("prove_dlog", p)?,
        entry("cand_2_leaves", cand_2)?,
        entry("cor_2_leaves", cor_2)?,
    ];

    Ok(SigmaPropBytesFixture {
        description:
            "SigmaPropBytes eval arm (phase 2g.5 Task 2). Pattern A cost: addPerItemCost(35, 6, 1, 1) BEFORE eval-children. Source: ergotree-interpreter/src/eval/sigma_prop_bytes.rs.",
        entries,
    })
}
