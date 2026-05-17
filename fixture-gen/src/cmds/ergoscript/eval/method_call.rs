//! Method-call dispatcher fixtures — phase 2g.5 Tasks 4, 5, 6.
//!
//! Task 4 (SBox.tokens handler):
//!   PropertyCall typeId=99, methodId=8. Cost 15 (Pattern A within handler).
//!   Returns Coll[(Coll[Byte], Long)] from self_box.tokens.
//!   Source: ergotree-interpreter/src/eval/sbox.rs:72-79 — TOKENS_EVAL_FN.
//!   Three sub-cases: 0 tokens, 1 token, 2 tokens.
//!
//! Task 5 (SContext.dataInputs handler):
//!   PropertyCall typeId=101, methodId=1. Cost 15 (Pattern A within handler).
//!   Returns Coll[Box] from ctx.data_inputs.
//!   Source: ergotree-interpreter/src/eval/scontext.rs:17-31 — DATA_INPUTS_EVAL_FN.
//!   Two sub-cases: 0 data-inputs, 2 data-inputs.
//!
//! Each entry includes a `ctx` field hint so the TS test knows how to
//! synthesize the evaluation context.

use core::cell::Cell;

use ergo_chain_types::{BlockId, Digest32, EcPoint, PreHeader, Votes};
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::{Context, ContextExtensionProvider};
use ergotree_ir::chain::context_extension::ContextExtension;
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::token::{Token, TokenAmount, TokenId};
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::sbox;
use ergotree_ir::types::scontext;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;
use sigma_test_util::force_any_val;

use super::common::value_to_json;

/// Minimal ContextExtensionProvider.
struct SimpleExtProvider(ContextExtension);

impl ContextExtensionProvider for SimpleExtProvider {
    fn context_extension(&self, _input_index: usize) -> Option<&ContextExtension> {
        Some(&self.0)
    }
}

/// Build a minimal ErgoTree (v1, hasSize=true, body = Const(SBoolean true)).
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build a 32-byte all-zero TxId.
fn zero_tx_id() -> TxId {
    TxId::zero()
}

/// Build a deterministic Token with a repeated-byte token id and given amount.
///
/// `byte` is used to fill the 32-byte token id (e.g., 0x00, 0x01, 0x02...).
/// `amount` is the token amount.
fn make_token(byte: u8, amount: u64) -> Token {
    let id_hex = hex::encode([byte; 32]);
    let token_id = TokenId::from(Digest32::try_from(id_hex).expect("Digest32"));
    let token_amount = TokenAmount::try_from(amount).expect("TokenAmount");
    Token {
        token_id,
        amount: token_amount,
    }
}

/// Construct an ErgoBox with the given tokens vector.
fn box_with_tokens(tokens: Vec<Token>) -> ErgoBox {
    let value = BoxValue::new(1_000_000).expect("BoxValue");
    let tokens_opt = if tokens.is_empty() {
        None
    } else {
        Some(
            ergotree_ir::chain::ergo_box::BoxTokens::from_vec(tokens).expect("BoxTokens"),
        )
    };
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: tokens_opt,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 0,
    };
    ErgoBox::from_box_candidate(&candidate, zero_tx_id(), 0).expect("ErgoBox")
}

/// Build a controlled Context where self_box is set to the provided static reference.
fn controlled_context(self_box: &'static ErgoBox) -> Context<'static> {
    let gen_bytes = hex::decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    )
    .expect("decode gen bytes");
    let miner_pk: EcPoint = EcPoint::scorex_parse_bytes(&gen_bytes).expect("parse gen point");

    let base_ctx = force_any_val::<Context<'static>>();
    let pre_header = PreHeader {
        version: 1,
        parent_id: BlockId(Digest32::zero()),
        timestamp: 1_700_000_000_000u64,
        n_bits: 0x1d00ffff,
        height: 1,
        miner_pk: Box::new(miner_pk),
        votes: Votes([0, 0, 0]),
    };

    let ext: &'static ContextExtension = Box::leak(Box::new(ContextExtension::empty()));
    let ext_provider: &'static SimpleExtProvider =
        Box::leak(Box::new(SimpleExtProvider(ContextExtension::empty())));

    Context {
        height: 1,
        self_box,
        outputs: std::slice::from_ref(self_box),
        data_inputs: None,
        inputs: vec![self_box].try_into().expect("inputs TxIoVec"),
        pre_header,
        headers: base_ctx.headers,
        extension: ext,
        tree_version: Cell::new(ErgoTreeVersion::V0),
        extension_provider: ext_provider,
        jit_cost: Cell::new(0),
        jit_cost_limit: None,
        constants: None,
    }
}

#[derive(Serialize)]
pub struct MethodCallFixture {
    pub description: &'static str,
    pub entries: Vec<MethodCallEntry>,
}

#[derive(Serialize)]
pub struct MethodCallEntry {
    pub name: String,
    pub tree_bytes_hex: String,
    /// ctx hints for the TS test side (token list for synthesizeStubBox).
    pub ctx: JsonValue,
    pub expected_value_json: JsonValue,
    pub expected_cost: u64,
}

/// Build a SBox.tokens PropertyCall tree targeting SELF (GlobalVars::SelfBox).
fn tokens_property_call_tree() -> anyhow::Result<(ErgoTree, String)> {
    let pc: Expr = PropertyCall::new(GlobalVars::SelfBox.into(), sbox::TOKENS_METHOD.clone())
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &pc)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Build a controlled Context where self_box has tokens and data_inputs has
/// `data_inputs_count` deterministic stub boxes (no tokens, value=1_000_000).
fn controlled_context_with_data_inputs(
    self_box: &'static ErgoBox,
    data_input_boxes: Vec<&'static ErgoBox>,
) -> Context<'static> {
    let gen_bytes = hex::decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    )
    .expect("decode gen bytes");
    let miner_pk: EcPoint = EcPoint::scorex_parse_bytes(&gen_bytes).expect("parse gen point");

    let base_ctx = force_any_val::<Context<'static>>();
    let pre_header = PreHeader {
        version: 1,
        parent_id: BlockId(Digest32::zero()),
        timestamp: 1_700_000_000_000u64,
        n_bits: 0x1d00ffff,
        height: 1,
        miner_pk: Box::new(miner_pk),
        votes: Votes([0, 0, 0]),
    };

    let ext: &'static ContextExtension = Box::leak(Box::new(ContextExtension::empty()));
    let ext_provider: &'static SimpleExtProvider =
        Box::leak(Box::new(SimpleExtProvider(ContextExtension::empty())));

    let data_inputs_opt = if data_input_boxes.is_empty() {
        None
    } else {
        Some(
            ergotree_ir::chain::context::TxIoVec::from_vec(data_input_boxes)
                .expect("data_inputs TxIoVec"),
        )
    };

    Context {
        height: 1,
        self_box,
        outputs: std::slice::from_ref(self_box),
        data_inputs: data_inputs_opt,
        inputs: vec![self_box].try_into().expect("inputs TxIoVec"),
        pre_header,
        headers: base_ctx.headers,
        extension: ext,
        tree_version: Cell::new(ErgoTreeVersion::V0),
        extension_provider: ext_provider,
        jit_cost: Cell::new(0),
        jit_cost_limit: None,
        constants: None,
    }
}

fn sbox_tokens_entry(name: &str, tokens: Vec<Token>) -> anyhow::Result<MethodCallEntry> {
    let (tree, tree_bytes_hex) = tokens_property_call_tree()?;

    // Build the ctx hint JSON for the TS test (token ids + amounts as strings).
    let tokens_hint: Vec<JsonValue> = tokens
        .iter()
        .map(|t| {
            let id_hex = hex::encode(t.token_id.as_ref());
            let amount: u64 = u64::from(t.amount);
            json!({ "id": id_hex, "amount": amount.to_string() })
        })
        .collect();

    // Build a static self_box and controlled context.
    let self_box: &'static ErgoBox = Box::leak(Box::new(box_with_tokens(tokens)));
    let ctx = controlled_context(self_box);

    let val: ergotree_ir::mir::value::Value<'static> =
        try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(MethodCallEntry {
        name: name.to_string(),
        tree_bytes_hex,
        ctx: json!({ "self_box_tokens": tokens_hint }),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

/// Build a SContext.dataInputs PropertyCall tree (PropertyCall on Expr::Context).
fn data_inputs_property_call_tree() -> anyhow::Result<(ErgoTree, String)> {
    let pc: Expr =
        PropertyCall::new(Expr::Context, scontext::DATA_INPUTS_PROPERTY.clone())?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &pc)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn scontext_data_inputs_entry(
    name: &str,
    data_inputs_count: usize,
) -> anyhow::Result<MethodCallEntry> {
    let (tree, tree_bytes_hex) = data_inputs_property_call_tree()?;

    // Build `data_inputs_count` deterministic stub boxes (empty tokens, value=1_000_000).
    let data_input_boxes: Vec<&'static ErgoBox> = (0..data_inputs_count)
        .map(|_| {
            let b: &'static ErgoBox = Box::leak(Box::new(box_with_tokens(vec![])));
            b
        })
        .collect();

    let self_box: &'static ErgoBox = Box::leak(Box::new(box_with_tokens(vec![])));
    let ctx = controlled_context_with_data_inputs(self_box, data_input_boxes);

    let val: ergotree_ir::mir::value::Value<'static> =
        try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(MethodCallEntry {
        name: name.to_string(),
        tree_bytes_hex,
        ctx: json!({ "data_inputs_count": data_inputs_count }),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<MethodCallFixture> {
    let mut entries = Vec::new();

    // SBox.tokens — three sub-cases: 0, 1, 2 tokens.
    entries.push(sbox_tokens_entry("sbox_tokens_empty", vec![])?);
    entries.push(sbox_tokens_entry(
        "sbox_tokens_1_token",
        vec![make_token(0x01, 100)],
    )?);
    entries.push(sbox_tokens_entry(
        "sbox_tokens_2_tokens",
        vec![make_token(0x01, 100), make_token(0x02, 200)],
    )?);

    // SContext.dataInputs — two sub-cases: 0 data-inputs, 2 data-inputs.
    entries.push(scontext_data_inputs_entry("scontext_data_inputs_empty", 0)?);
    entries.push(scontext_data_inputs_entry("scontext_data_inputs_2_boxes", 2)?);

    Ok(MethodCallFixture {
        description: "MethodCall/PropertyCall dispatcher + SBox.tokens + SContext.dataInputs handlers (phase 2g.5 Tasks 4-5). Sources: eval/sbox.rs:72-79, eval/scontext.rs:17-31.",
        entries,
    })
}
