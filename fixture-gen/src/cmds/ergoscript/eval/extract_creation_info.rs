//! ExtractCreationInfo arm — fixtures for `Expr::ExtractCreationInfo(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/extract_creation_info.rs:9-25`
//!   ctx.add_jit_cost(16)?;                          // BEFORE eval-child (Pattern A)
//!   let input_v = self.input.eval(env, ctx)?;
//!   match input_v { Value::CBox(b) => Ok(b.creation_info().into()), ... }
//!
//! `ErgoBox::creation_info` (`chain/ergo_box.rs:185-192`):
//!   bytes = txId (32 bytes) ++ index.to_be_bytes()   (2 bytes; u16 BE)
//!   return (creation_height as i32, bytes)
//! Total: 34 bytes in Coll[Byte].
//!
//! Cost ordering: Fixed(16) charged BEFORE eval-child (Pattern A — envelope-first).
//! Const(SBox) arm charges Fixed(5); total fixture cost = 21.
//!
//! Coverage:
//!   - `extract_creation_info_default`   — creation_height=0, txId=zeros, index=0
//!   - `extract_creation_info_realistic` — creation_height=12345, realistic txId, index=3
//!   - `extract_creation_info_max_index` — index=65535 (u16 max; BE bytes 0xff 0xff)
//!   - `extract_creation_info_high_height` — creation_height=1_000_000_000 (near i32 max)
//!   - `extract_creation_info_cost_limit` — jitCostLimit=1 < Fixed(16) → 'cost-limit-exceeded'

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_creation_info::ExtractCreationInfo;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ExtractCreationInfoFixture {
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
pub struct ExtractCreationInfoFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ExtractCreationInfoFixture>,
}

/// Build a minimal ErgoTree (v1, hasSize=true, body = Const(SBoolean true)).
///
/// v1 is required: the TS SBox parser reads the ergoTree header and demands
/// `hasSize=true` (bit 3) to bound the read without a full body parse.
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build a 32-byte all-zero TxId.
fn zero_tx_id() -> TxId {
    TxId::zero()
}

/// Build a TxId from a 32-byte array.
fn tx_id_from_bytes(bytes: [u8; 32]) -> TxId {
    TxId(ergo_chain_types::Digest32::from(bytes))
}

/// Construct a box with the given parameters.
fn make_box(creation_height: u32, tx_id: TxId, index: u16) -> ErgoBox {
    let value = BoxValue::new(BoxValue::MIN_RAW).expect("BoxValue");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height,
    };
    ErgoBox::from_box_candidate(&candidate, tx_id, index).expect("ErgoBox")
}

/// Build an `ExtractCreationInfo { input: Const(SBox, box) }` ErgoTree and return its hex.
fn build_tree(ergo_box: ErgoBox) -> anyhow::Result<(ErgoTree, String)> {
    let box_const: Constant = ergo_box.into();
    let input: Expr = Expr::Const(box_const);
    let node = ExtractCreationInfo::try_build(input)
        .map_err(|e| anyhow::anyhow!("ExtractCreationInfo::try_build: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, ergo_box: ErgoBox) -> anyhow::Result<ExtractCreationInfoFixture> {
    let (tree, hex) = build_tree(ergo_box)?;
    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ExtractCreationInfoFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn cost_limit_entry(
    name: &str,
    ergo_box: ErgoBox,
    limit: u64,
) -> anyhow::Result<ExtractCreationInfoFixture> {
    let (_tree, hex) = build_tree(ergo_box)?;
    Ok(ExtractCreationInfoFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<ExtractCreationInfoFixtureFile> {
    let mut entries = Vec::new();

    // ── Default box: height=0, all-zero txId, index=0 ───────────────────────
    // Combined bytes: [0x00; 32] ++ [0x00, 0x00] = 34 zero bytes.
    entries.push(success_entry(
        "extract_creation_info_default",
        make_box(0, zero_tx_id(), 0),
    )?);

    // ── Realistic: height=12345, patterned txId, index=3 ────────────────────
    // txId = [0x01, 0x02, ..., 0x20] (bytes 1..32 sequentially).
    // Combined bytes: [0x01..0x20] ++ [0x00, 0x03].
    {
        let mut tx_bytes = [0u8; 32];
        for (i, b) in tx_bytes.iter_mut().enumerate() {
            *b = (i as u8) + 1;
        }
        entries.push(success_entry(
            "extract_creation_info_realistic",
            make_box(12345, tx_id_from_bytes(tx_bytes), 3),
        )?);
    }

    // ── Max index: index=65535 (u16 max) ────────────────────────────────────
    // Combined bytes: [0x00; 32] ++ [0xff, 0xff].
    entries.push(success_entry(
        "extract_creation_info_max_index",
        make_box(0, zero_tx_id(), 65535),
    )?);

    // ── High height: creation_height=1_000_000_000 ──────────────────────────
    // Tests that large creation_height round-trips correctly as SInt (i32).
    // 1_000_000_000 fits in i32 (max i32 = 2_147_483_647).
    entries.push(success_entry(
        "extract_creation_info_high_height",
        make_box(1_000_000_000, zero_tx_id(), 0),
    )?);

    // ── Cost-limit: jitCostLimit=1 < Fixed(16) ──────────────────────────────
    // Pattern A: cost charged BEFORE eval-child. addCost(16) fires immediately.
    entries.push(cost_limit_entry(
        "extract_creation_info_cost_limit_exceeded",
        make_box(0, zero_tx_id(), 0),
        1,
    )?);

    Ok(ExtractCreationInfoFixtureFile {
        corpus: "eval_extract_creation_info",
        entries,
    })
}
