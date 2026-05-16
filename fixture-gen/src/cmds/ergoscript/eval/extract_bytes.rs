//! ExtractBytes arm — fixtures for `Expr::ExtractBytes(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/extract_bytes.rs:9-25`
//!   ctx.add_jit_cost(12)?;                           // BEFORE eval-child
//!   let input_v = self.input.eval(env, ctx)?;
//!   match input_v { Value::CBox(b) => Ok(b.sigma_serialize_bytes()?.into()), ... }
//!
//! Cost ordering: Fixed(12) charged BEFORE eval-child (Pattern A — envelope-first).
//! Const(SBox) arm charges Fixed(5); total fixture cost = 17.
//!
//! `b.sigma_serialize_bytes()` returns the full canonical ErgoBox bytes:
//!   value + ergoTree + creation_height + tokens + registers + tx_id + index
//!
//! Coverage:
//!   - `extract_bytes_minimal`         — minimal box (no tokens, no registers, height=0)
//!   - `extract_bytes_with_tokens`     — box with 3 tokens, no registers
//!   - `extract_bytes_with_registers`  — box with R4–R6 populated, no tokens
//!   - `extract_bytes_mixed`           — box with 2 tokens + R4+R5 registers
//!   - `extract_bytes_cost_limit`      — jitCostLimit=1 < Fixed(12) → 'cost-limit-exceeded'
//!
//! Error case (`'extract-input-not-box'`): sigma-rust's `ExtractBytes::try_build`
//! calls `input.check_post_eval_tpe(&SType::SBox)` and rejects non-SBox inputs at
//! construction time. The TS-side defensive kind-check is exercised by inline
//! tests in `test/eval/extract-bytes.test.ts`.

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
use ergotree_ir::mir::extract_bytes::ExtractBytes;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use std::convert::TryFrom;
use std::sync::Arc;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ExtractBytesFixture {
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
pub struct ExtractBytesFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ExtractBytesFixture>,
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

/// Build an `ExtractBytes { input: Const(SBox, box) }` ErgoTree and return its hex.
fn build_tree(ergo_box: ErgoBox) -> anyhow::Result<(ErgoTree, String)> {
    let box_const: Constant = ergo_box.into();
    let input: Expr = Expr::Const(box_const);
    let node = ExtractBytes::try_build(input)
        .map_err(|e| anyhow::anyhow!("ExtractBytes::try_build: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, ergo_box: ErgoBox) -> anyhow::Result<ExtractBytesFixture> {
    let (tree, hex) = build_tree(ergo_box)?;
    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ExtractBytesFixture {
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
) -> anyhow::Result<ExtractBytesFixture> {
    let (_tree, hex) = build_tree(ergo_box)?;
    Ok(ExtractBytesFixture {
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

/// Box with 2 tokens AND R4 (SLong) + R5 (SColl[SByte]) registers.
fn box_mixed() -> ErgoBox {
    use ergotree_ir::mir::constant::Literal;
    use ergotree_ir::mir::value::{CollKind, NativeColl};

    let value = BoxValue::new(10_000_000u64).expect("BoxValue");

    let tokens_vec = vec![
        Token {
            token_id: token_id(0xaa),
            amount: TokenAmount::try_from(999u64).expect("amount"),
        },
        Token {
            token_id: token_id(0xbb),
            amount: TokenAmount::try_from(1u64).expect("amount"),
        },
    ];
    let box_tokens = BoxTokens::from_vec(tokens_vec).expect("BoxTokens");

    let r4: Constant = 9_876_543_210i64.into();
    let r5_bytes: Vec<i8> = vec![0x0a_i8, 0x0b, 0x0c, 0x0d];
    let r5 = Constant {
        tpe: SType::SColl(Arc::new(SType::SByte)),
        v: Literal::Coll(CollKind::NativeColl(NativeColl::CollByte(r5_bytes.into()))),
    };

    let regs = NonMandatoryRegisters::new([
        (NonMandatoryRegisterId::R4, r4),
        (NonMandatoryRegisterId::R5, r5),
    ])
    .expect("registers R4+R5");

    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: Some(box_tokens),
        additional_registers: regs,
        creation_height: 1_000_000,
    };
    ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0xde), 5)
        .expect("ErgoBox mixed")
}

pub fn generate() -> anyhow::Result<ExtractBytesFixtureFile> {
    let mut entries = Vec::new();

    // Minimal box — smallest possible canonical bytes.
    entries.push(success_entry("extract_bytes_minimal", box_minimal())?);

    // Box with 3 tokens — token list exercises per-token serialization.
    entries.push(success_entry("extract_bytes_with_tokens", box_with_tokens())?);

    // Box with R4–R6 registers — register section exercises non-mandatory regs.
    entries.push(success_entry("extract_bytes_with_registers", box_with_registers())?);

    // Box with tokens + registers — exercises both sections together.
    entries.push(success_entry("extract_bytes_mixed", box_mixed())?);

    // Cost-limit: 1 < Fixed(12) — addCost(12) overshoots immediately.
    // Pattern A: cost charged BEFORE eval-child, so the limit fires before
    // Const(SBox) is evaluated.
    entries.push(cost_limit_entry(
        "extract_bytes_cost_limit_exceeded",
        box_minimal(),
        1,
    )?);

    Ok(ExtractBytesFixtureFile {
        corpus: "eval_extract_bytes",
        entries,
    })
}
