//! SigmaPropIsProven arm — captures the structural-throw shape.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25
//!   Always returns Err(EvalError::Misc("SigmaPropIsProven has no interpreter eval..."))
//!   regardless of input. `_env` and `_ctx` are unused — no eval of `self.input`,
//!   no cost charged.
//!
//! Op-code 95 is reserved in the IR for byte-match parity with Scala
//! sigmastate, whose typer rewrites `prop.isProven` to a SigmaPropIsProven
//! node. The AOT graph-IR rewrite removes the node before evaluation; the
//! bytecode interpreter therefore receives a node that always throws.
//!
//! Per the throw-only fixture-gen convention (mirrored from decode_point.rs's
//! `error_entry`), the fixture builds a syntactically valid tree but does NOT
//! call `try_eval_out` — the input never matters, and the TS test asserts only
//! the expected error code (`'sigma-prop-is-proven-no-eval'`).

use ergo_chain_types::ec_point::generator;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::{Constant, Literal};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::sigma_prop_is_proven::SigmaPropIsProven;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp,
};
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};

#[derive(Serialize)]
pub struct SigmaPropIsProvenFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// Always null for this arm — never returns a value.
    pub expected_value_json: JsonValue,
    /// Always 0 — no cost charged on the structural-throw path.
    pub expected_cost: u64,
    /// Always `"sigma-prop-is-proven-no-eval"`.
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct SigmaPropIsProvenFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<SigmaPropIsProvenFixture>,
}

/// Build a `Const(SSigmaProp, ProveDlog(generator))` expression.
/// Mirrors `sigma_prop_bytes.rs::sigma_prop_const` precedent.
fn sigma_prop_const_generator() -> Expr {
    let sb: SigmaBoolean = SigmaBoolean::ProofOfKnowledge(
        SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(generator())),
    );
    let sp = SigmaProp::new(sb);
    Expr::Const(Constant {
        tpe: SType::SSigmaProp,
        v: Literal::SigmaProp(Box::new(sp)),
    })
}

pub fn generate() -> anyhow::Result<SigmaPropIsProvenFixtureFile> {
    // Single scenario: SigmaPropIsProven { input: Const(SSigmaProp, ProveDlog(generator)) }.
    // The input is never evaluated by sigma-rust (the arm throws structurally before
    // touching `self.input`), but we choose a syntactically valid SigmaProp const for
    // the post_eval_tpe build-time check (`OneArgOpTryBuild::try_build` requires
    // input.check_post_eval_tpe(&SType::SSigmaProp) — see
    // ergotree-ir/src/mir/sigma_prop_is_proven.rs:40-45).
    let input_expr = sigma_prop_const_generator();
    let body: Expr = SigmaPropIsProven {
        input: Box::new(input_expr),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let entry = SigmaPropIsProvenFixture {
        name: "sigma_prop_is_proven_const_sigma_prop_input".to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("sigma-prop-is-proven-no-eval"),
    };

    Ok(SigmaPropIsProvenFixtureFile {
        corpus: "eval_sigma_prop_is_proven",
        entries: vec![entry],
    })
}
