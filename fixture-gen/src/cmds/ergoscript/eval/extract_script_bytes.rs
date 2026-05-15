//! ExtractScriptBytes arm — fixtures for `Expr::ExtractScriptBytes(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/extract_script_bytes.rs:9-25`
//!   ctx.add_jit_cost(10)?;                           // BEFORE eval-child
//!   let input_v = self.input.eval(env, ctx)?;
//!   match input_v { Value::CBox(b) => b.script_bytes()?.into(), ... }
//!
//! Cost ordering: Fixed(10) charged BEFORE eval-child (Pattern A — envelope-first).
//! Source: sigma-rust eval/extract_script_bytes.rs:15.
//!
//! `box.script_bytes()` serializes `box.ergo_tree` via `sigma_serialize_bytes()`.
//! In TS, `ErgoBox.ergoTreeBytes` holds these bytes directly from parse time (Task 1),
//! so `bytesToCollByteSValue(input.value.ergoTreeBytes)` mirrors the Rust path exactly.
//!
//! Coverage:
//!   - Box with minimal v1 tree (Const(SBoolean true) — same as extract_amount).
//!   - Box with P2PK ProveDlog tree (37 bytes; realistic on-chain script type).
//!   - Box with larger nested expression (If body, 9 bytes; multi-node tree body).
//!   - Box with v1 tree using segregated constants (hasConstants=true).
//!   - 1 cost-limit entry (jitCostLimit=1 < Fixed(10)) → `'cost-limit-exceeded'`.
//!
//! Error case (`'extract-input-not-box'`): sigma-rust's `ExtractScriptBytes::try_build`
//! calls `input.check_post_eval_tpe(&SType::SBox)` and rejects non-SBox inputs at
//! construction time — cannot be serialized through the standard path. The TS-side
//! assertion is covered by inline tests in `test/eval/extract-script-bytes.test.ts`.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_script_bytes::ExtractScriptBytes;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree,
};
use ergo_chain_types::EcPoint;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ExtractScriptBytesFixture {
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
pub struct ExtractScriptBytesFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ExtractScriptBytesFixture>,
}

/// Build a minimal ErgoTree (v1, hasSize=true, body = Const(SBoolean true)).
///
/// v1 is required: the TS SBox parser reads the ergoTree header and demands
/// `hasSize=true` (bit 3) to bound the read without a full body parse. All
/// real on-chain boxes use v1+. Mirrors `extract_amount.rs::minimal_ergo_tree`.
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build a P2PK (ProveDlog) ErgoTree — realistic on-chain script.
///
/// Uses a well-known compressed SEC1 public key point. The tree body is
/// a ProveDlog SigmaProp constant (~35 bytes including the v1+size header).
fn p2pk_ergo_tree() -> ErgoTree {
    // Known compressed SEC1 public key (33 bytes, prefix 0x02).
    let pk_bytes = hex::decode("02764ea2b0b9b06b5730a4257bba71fd7797eb1ec12bc3ae6025a01d7fba53830e")
        .expect("hex decode");
    let ec = EcPoint::sigma_parse_bytes(&pk_bytes)
        .expect("EcPoint");
    let pd = ProveDlog::new(ec);
    let sb = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pd));
    let sp = ergotree_ir::sigma_protocol::sigma_boolean::SigmaProp::new(sb);
    let constant: Constant = sp.into();
    let expr = Expr::Const(constant);
    ErgoTree::new(ErgoTreeHeader::v1(false), &expr).expect("P2PK ErgoTree")
}

/// Build a slightly larger ErgoTree by nesting an If expression.
///
/// Body: If(Const(true), Const(true), Const(false)) → still a valid script,
/// longer body than the minimal single-const tree.
fn larger_ergo_tree() -> ErgoTree {
    use ergotree_ir::mir::if_op::If;
    let cond = Expr::Const(true.into());
    let then_br = Expr::Const(true.into());
    let else_br = Expr::Const(false.into());
    let if_expr = Expr::If(If {
        condition: Box::new(cond),
        true_branch: Box::new(then_br),
        false_branch: Box::new(else_br),
    });
    ErgoTree::new(ErgoTreeHeader::v1(false), &if_expr).expect("larger ErgoTree")
}

/// Build an ErgoTree with segregated constants (v1, hasConstants=true).
///
/// This uses a simple constant-segregated tree. In the wire format,
/// hasConstants=true means constants are extracted from the body, changing
/// the byte layout. `ergoTreeBytes` captures the full wire form including
/// the constants section.
fn segregated_constants_ergo_tree() -> ErgoTree {
    let expr = Expr::Const(42i32.into());
    // v1(true) means hasSize=true, hasConstants=true (segregated constants)
    ErgoTree::new(ErgoTreeHeader::v1(true), &expr).expect("segregated ErgoTree")
}

/// Build a 32-byte all-zero TxId.
fn zero_tx_id() -> TxId {
    TxId::zero()
}

/// Construct an ErgoBox with the given tree, zero tokens, empty registers.
fn box_with_tree(ergo_tree: ErgoTree) -> ErgoBox {
    let value = BoxValue::new(1_000_000).expect("BoxValue");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree,
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 0,
    };
    ErgoBox::from_box_candidate(&candidate, zero_tx_id(), 0).expect("ErgoBox")
}

/// Build an `ExtractScriptBytes { input: Const(SBox, box) }` ErgoTree and return its hex.
fn build_tree(ergo_box: ErgoBox) -> anyhow::Result<(ErgoTree, String)> {
    let box_const: Constant = ergo_box.into();
    let input: Expr = Expr::Const(box_const);
    let expr: Expr = ExtractScriptBytes {
        input: Box::new(input),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, ergo_box: ErgoBox) -> anyhow::Result<ExtractScriptBytesFixture> {
    let (tree, hex) = build_tree(ergo_box)?;
    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ExtractScriptBytesFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Cost-limit entry — `jitCostLimit` set below Fixed(10) so `addCost` overshoots.
fn cost_limit_entry(
    name: &str,
    ergo_box: ErgoBox,
    limit: u64,
) -> anyhow::Result<ExtractScriptBytesFixture> {
    let (_tree, hex) = build_tree(ergo_box)?;
    Ok(ExtractScriptBytesFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<ExtractScriptBytesFixtureFile> {
    let mut entries = Vec::new();

    // Minimal v1 tree (Const(SBoolean true)) — smallest possible ergoTreeBytes.
    entries.push(success_entry(
        "extract_script_bytes_minimal",
        box_with_tree(minimal_ergo_tree()),
    )?);

    // P2PK ProveDlog tree (~35 bytes) — realistic on-chain script type.
    entries.push(success_entry(
        "extract_script_bytes_p2pk",
        box_with_tree(p2pk_ergo_tree()),
    )?);

    // Larger nested tree (If expression body) — multi-node body.
    entries.push(success_entry(
        "extract_script_bytes_larger",
        box_with_tree(larger_ergo_tree()),
    )?);

    // Segregated constants tree (hasConstants=true in header) — different wire layout.
    entries.push(success_entry(
        "extract_script_bytes_segregated_constants",
        box_with_tree(segregated_constants_ergo_tree()),
    )?);

    // Cost-limit: 1 < Fixed(10) — addCost(10) overshoots immediately.
    // Cost is charged BEFORE eval-child, so the limit fires before Const(SBox)
    // is evaluated. The ctx.addCost(10) throws 'cost-limit-exceeded'.
    entries.push(cost_limit_entry(
        "extract_script_bytes_cost_limit_exceeded",
        box_with_tree(minimal_ergo_tree()),
        1,
    )?);

    Ok(ExtractScriptBytesFixtureFile {
        corpus: "eval_extract_script_bytes",
        entries,
    })
}
