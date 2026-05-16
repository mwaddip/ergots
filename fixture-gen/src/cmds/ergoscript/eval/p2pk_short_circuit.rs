//! P2PK short-circuit smoking-gun fixture (phase 2g-medium Task 3).
//!
//! A bare `Const(SSigmaProp, ProveDlog(pk))` tree evaluates with cost = 50
//! (sigma-rust's EVAL_SIGMA_PROP_CONSTANT), NOT 5 (standard Const charge).
//!
//! The short-circuit lives in sigma-rust's `reduce_to_crypto` (`eval.rs:138-158,
//! 268-278`) as a `trivial_reduce` path — it charges a flat 50 JitCost for
//! any `Const(SSigmaProp)` or `ConstPlaceholder` resolving to SSigmaProp,
//! bypassing normal `Expr::Const` eval entirely.
//!
//! TS implementation: `tryTrivialReduce` in `src/eval/evaluate.ts` fires at
//! the root of `evaluate` / `evaluateWith` and charges a flat 50 (via
//! `ctx.addCost(50)`) when the tree body is `Const(SSigmaProp, _)` or a
//! `ConstPlaceholder` resolving to a SigmaProp — bypassing `evalConst`
//! entirely. Nested SigmaProp Consts (e.g. inside a BinOp) still go through
//! `evalConst` and charge 5.
//!
//! The fixture exercises the NON-segregated case: a bare Const(SSigmaProp)
//! in the tree body (no constant-segregation section). This corresponds to
//! `trivial_reduce` matching the `Expr::Const` arm in sigma-rust.

use ergo_chain_types::ec_point::generator;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp,
};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};

#[derive(Serialize)]
pub struct P2pkEntry {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    pub expected_value_json: JsonValue,
    pub expected_cost: u64,
}

#[derive(Serialize)]
pub struct P2pkFixture {
    pub description: &'static str,
    pub entries: Vec<P2pkEntry>,
}

pub fn generate() -> anyhow::Result<P2pkFixture> {
    // Use secp256k1 generator G as the deterministic public key (matches create_prove_dlog.rs basic entry).
    let pk = generator();

    // Build SigmaBoolean::ProofOfKnowledge(ProveDlog(pk))
    let sigma_bool =
        SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(pk)));
    let sigma_prop = SigmaProp::new(sigma_bool.clone());

    // Build: Const(SSigmaProp, SigmaProp(...))
    // From<SigmaProp> for Constant is implemented.
    let const_val: Constant = sigma_prop.into();
    let body = Expr::Const(const_val);
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    // expected_value_json: { kind: "SigmaProp", raw_hex: <SigmaBoolean sigma_serialize_bytes> }
    // raw_hex = raw SigmaBoolean wire bytes (NOT ErgoTree prop_bytes).
    // Matches TS hydrateSValue('SigmaProp') which calls parseSigmaBoolean(ByteReader(bytes)).
    let raw_bytes = sigma_bool.sigma_serialize_bytes()?;
    let expected_value_json = json!({
        "kind": "SigmaProp",
        "raw_hex": hex::encode(&raw_bytes)
    });

    // expected_cost = 50 (EVAL_SIGMA_PROP_CONSTANT from sigma-rust eval.rs:138)
    let expected_cost: u64 = 50;

    Ok(P2pkFixture {
        description: "P2PK short-circuit: Const(SSigmaProp, ProveDlog(pk)) charges 50 JitCost via EVAL_SIGMA_PROP_CONSTANT (sigma-rust eval.rs:138-158). TS: tryTrivialReduce in src/eval/evaluate.ts fires at the root and charges 50 directly, bypassing evalConst.",
        entries: vec![P2pkEntry {
            name: "p2pk-sigma-prop-const-cost-50".to_string(),
            tree_bytes_hex,
            opts_json: json!({}),
            expected_value_json,
            expected_cost,
        }],
    })
}
