//! ExtractId arm — fixtures for `Expr::ExtractId(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/extract_id.rs:10-28`
//!   ctx.add_jit_cost(12)?;                           // BEFORE eval-child
//!   let input_v = self.input.eval(env, ctx)?;
//!   match input_v { Value::CBox(b) => { let bytes: Vec<i8> = b.box_id().into(); ... }, ... }
//!
//! Cost ordering: Fixed(12) charged BEFORE eval-child (Pattern A — envelope-first).
//! Const(SBox) arm charges Fixed(5); total fixture cost = 17.
//!
//! `b.box_id()` returns a cached `BoxId` computed at construction as
//! `blake2b256_hash(sigma_serialize_bytes(box))`. The 32-byte digest is then
//! converted to `Vec<i8>` and wrapped as `Value::Coll(NativeColl::CollByte(...))`.
//!
//! First eval-time blake2b call in the TS package — uses the existing
//! `@noble/hashes/blake2.js` dep from phase 2a.
//!
//! Coverage:
//!   - `extract_id_minimal`         — minimal box (no tokens, no registers, height=0)
//!   - `extract_id_with_tokens`     — box with 3 tokens, no registers
//!   - `extract_id_with_registers`  — box with R4–R6 populated, no tokens
//!   - `extract_id_cost_limit`      — jitCostLimit < Fixed(12) → 'cost-limit-exceeded'
//!
//! Error case (`'extract-input-not-box'`): sigma-rust's `ExtractId::try_build`
//! calls `input.check_post_eval_tpe(&SType::SBox)` and rejects non-SBox inputs at
//! construction time. The TS-side defensive kind-check is exercised by inline
//! tests in `test/eval/extract-id.test.ts`.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::chain::ergo_box::{
    ErgoBox, ErgoBoxCandidate, NonMandatoryRegisterId, NonMandatoryRegisters,
};
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::ergo_box::BoxTokens;
use ergotree_ir::chain::token::{Token, TokenAmount, TokenId};
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_id::ExtractId;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use std::convert::TryFrom;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ExtractIdFixture {
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
pub struct ExtractIdFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ExtractIdFixture>,
}

/// Build a minimal ErgoTree (v1, hasSize=true, body = Const(SBoolean true)).
///
/// v1 is required: the TS SBox parser reads the ergoTree header and demands
/// `hasSize=true` (bit 3) to bound the read without a full body parse. All
/// real on-chain boxes use v1+.
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build a 32-byte TxId from a single byte value repeated 32 times.
fn tx_id_from_byte(b: u8) -> TxId {
    let bytes: [u8; 32] = [b; 32];
    TxId(ergo_chain_types::Digest32::from(bytes))
}

/// Build a TokenId from a single byte value repeated 32 times.
fn token_id(byte: u8) -> TokenId {
    let bytes: [u8; 32] = [byte; 32];
    let digest: ergo_chain_types::Digest32 = ergo_chain_types::Digest32::from(bytes);
    digest.into()
}

/// Build an `ExtractId { input: Const(SBox, box) }` ErgoTree and return its hex.
fn build_tree(ergo_box: ErgoBox) -> anyhow::Result<(ErgoTree, String)> {
    let box_const: Constant = ergo_box.into();
    let input: Expr = Expr::Const(box_const);
    let node = ExtractId::try_build(input)
        .map_err(|e| anyhow::anyhow!("ExtractId::try_build: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, ergo_box: ErgoBox) -> anyhow::Result<ExtractIdFixture> {
    let (tree, hex) = build_tree(ergo_box)?;
    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ExtractIdFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Cost-limit entry — `jitCostLimit` set below Fixed(12) so `addCost` overshoots.
fn cost_limit_entry(
    name: &str,
    ergo_box: ErgoBox,
    limit: u64,
) -> anyhow::Result<ExtractIdFixture> {
    let (_tree, hex) = build_tree(ergo_box)?;
    Ok(ExtractIdFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

/// Minimal box — no tokens, no registers, height=0, value=1_000_000.
fn box_minimal() -> ErgoBox {
    let value = BoxValue::new(1_000_000u64).expect("BoxValue");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 0,
    };
    ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0x00), 0).expect("ErgoBox minimal")
}

/// Box with 3 tokens, no registers.
fn box_with_tokens() -> ErgoBox {
    let value = BoxValue::new(2_000_000u64).expect("BoxValue");
    let tokens_vec = vec![
        Token {
            token_id: token_id(0x01),
            amount: TokenAmount::try_from(100u64).expect("amount"),
        },
        Token {
            token_id: token_id(0x02),
            amount: TokenAmount::try_from(200u64).expect("amount"),
        },
        Token {
            token_id: token_id(0x03),
            amount: TokenAmount::try_from(300u64).expect("amount"),
        },
    ];
    let box_tokens = BoxTokens::from_vec(tokens_vec).expect("BoxTokens");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: Some(box_tokens),
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 100_000,
    };
    ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0xab), 1)
        .expect("ErgoBox with tokens")
}

/// Box with R4 (SInt), R5 (SBoolean), R6 (SLong) registers, no tokens.
fn box_with_registers() -> ErgoBox {
    let value = BoxValue::new(5_000_000u64).expect("BoxValue");

    let r4: Constant = 42i32.into();
    let r5: Constant = true.into();
    let r6: Constant = 1_234_567_890i64.into();

    let regs = NonMandatoryRegisters::new([
        (NonMandatoryRegisterId::R4, r4),
        (NonMandatoryRegisterId::R5, r5),
        (NonMandatoryRegisterId::R6, r6),
    ])
    .expect("registers R4+R5+R6");

    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: regs,
        creation_height: 500_000,
    };
    ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0x00), 2)
        .expect("ErgoBox with registers")
}

pub fn generate() -> anyhow::Result<ExtractIdFixtureFile> {
    let mut entries = Vec::new();

    // Minimal box — smallest possible canonical bytes → 32-byte blake2b256 hash.
    entries.push(success_entry("extract_id_minimal", box_minimal())?);

    // Box with 3 tokens — token list changes canonical bytes → different hash.
    entries.push(success_entry("extract_id_with_tokens", box_with_tokens())?);

    // Box with R4–R6 registers — register section changes canonical bytes → different hash.
    entries.push(success_entry("extract_id_with_registers", box_with_registers())?);

    // Cost-limit: 1 < Fixed(12) — addCost(12) overshoots immediately.
    // Pattern A: cost charged BEFORE eval-child, so the limit fires before
    // Const(SBox) is evaluated.
    entries.push(cost_limit_entry(
        "extract_id_cost_limit_exceeded",
        box_minimal(),
        1,
    )?);

    Ok(ExtractIdFixtureFile {
        corpus: "eval_extract_id",
        entries,
    })
}
