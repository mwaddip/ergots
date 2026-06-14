//! Box canonical-bytes fixtures for `@ergots/ergoscript`.
//!
//! Each entry captures the sigma-rust serialization of an `ErgoBox` in two
//! forms:
//!   `full_hex`   — `ErgoBox::sigma_serialize_bytes()` (value + ergoTree +
//!                   creation_height + tokens + registers + tx_id + index)
//!   `no_ref_hex` — `ErgoBox::bytes_without_ref()` (same body, omits tx_id
//!                   and index; matches `ErgoBoxCandidate` serialization)
//!
//! The TS side loads this fixture and calls:
//!   `serializeBoxBytes(box)` → asserts hex-equals `full_hex`
//!   `serializeBoxBytesWithoutRef(box)` → asserts hex-equals `no_ref_hex`
//!
//! Sigma-rust refs:
//!   chain/ergo_box.rs:195-198 (bytes_without_ref)
//!   chain/ergo_box.rs:201-223 (sigma_serialize for ErgoBox)
//!   chain/ergo_box.rs:302-344 (serialize_box_with_indexed_digests)

use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisterId, NonMandatoryRegisters};
use ergotree_ir::chain::token::{Token, TokenAmount, TokenId};
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::types::stype::SType;
use serde::Serialize;

use std::convert::TryFrom;

/// A single entry in the fixture: box fields the TS side needs to reconstruct
/// the ErgoBox struct plus the two expected byte arrays.
#[derive(Serialize)]
pub struct BoxBytesEntry {
    pub name: String,
    pub description: String,
    /// Full serialization including tx_id + index.
    pub full_hex: String,
    /// Serialization without tx_id + index (ErgoBoxCandidate form).
    pub no_ref_hex: String,
    /// The box fields as JSON so TS can reconstruct the ErgoBox without
    /// parsing the binary. These mirror `ErgoBox` interface fields.
    pub box_json: BoxJsonFields,
}

/// JSON representation of the box fields for TS reconstruction.
/// All byte arrays are hex-encoded strings.
#[derive(Serialize)]
pub struct BoxJsonFields {
    /// Decimal string for u64 value (avoids JSON number precision loss).
    pub value: String,
    /// ErgoTree bytes as hex.
    pub ergo_tree_hex: String,
    /// Creation height as u32.
    pub creation_height: u32,
    /// Tokens list.
    pub tokens: Vec<TokenJson>,
    /// Non-mandatory registers R4..R9 as Constant sigma_serialize_bytes hex.
    pub registers: Vec<RegisterJson>,
    /// 32-byte transaction id as hex.
    pub tx_id_hex: String,
    /// Output index (u16).
    pub index: u16,
}

#[derive(Serialize)]
pub struct TokenJson {
    pub id_hex: String,
    pub amount: String, // decimal string for u64
}

#[derive(Serialize)]
pub struct RegisterJson {
    /// Register id: 4..=9 (for R4..R9).
    pub id: u8,
    /// The full Constant sigma_serialize_bytes (SType + SValue) as hex.
    /// The TS parser already has `parseSValue` / `parseSType` — using the raw
    /// Constant bytes lets us reconstruct the typed register value without
    /// duplicating the type layout in JSON.
    pub constant_hex: String,
}

#[derive(Serialize)]
pub struct BoxBytesFixture {
    pub entries: Vec<BoxBytesEntry>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a minimal ErgoTree (v1, hasSize=true, body = Const(SBoolean true)).
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build a 32-byte TxId from a byte value repeated 32 times.
fn tx_id_from_byte(b: u8) -> TxId {
    let bytes: [u8; 32] = [b; 32];
    let digest = ergo_chain_types::Digest32::from(bytes);
    TxId(digest)
}

/// Build a 32-byte TokenId from a byte value repeated 32 times.
fn token_id(byte: u8) -> TokenId {
    let bytes: [u8; 32] = [byte; 32];
    let digest: ergo_chain_types::Digest32 = ergo_chain_types::Digest32::from(bytes);
    digest.into()
}

/// Serialize an ErgoBox to full hex.
fn full_hex(b: &ErgoBox) -> anyhow::Result<String> {
    Ok(hex::encode(b.sigma_serialize_bytes()?))
}

/// Serialize an ErgoBox to no-ref hex (without tx_id + index).
fn no_ref_hex(b: &ErgoBox) -> anyhow::Result<String> {
    let bytes_i8 = b.bytes_without_ref()?;
    // sigma-rust `bytes_without_ref` returns `Vec<i8>`; reinterpret as `Vec<u8>`.
    let bytes_u8: Vec<u8> = bytes_i8.into_iter().map(|b| b as u8).collect();
    Ok(hex::encode(bytes_u8))
}

/// Convert the TxId to a hex string.
fn tx_id_hex(tx_id: &TxId) -> String {
    hex::encode(tx_id.0.as_ref() as &[u8])
}

/// Convert TokenId to hex string.
fn token_id_hex(id: &TokenId) -> String {
    let bytes: Vec<u8> = id.sigma_serialize_bytes()
        .expect("TokenId serialize")
        .into_iter()
        .collect();
    hex::encode(bytes)
}

/// Convert a Constant to hex string via sigma_serialize_bytes.
fn constant_hex(c: &Constant) -> String {
    hex::encode(c.sigma_serialize_bytes().expect("Constant serialize"))
}

/// Build BoxJsonFields from an ErgoBox.
fn box_json_fields(b: &ErgoBox) -> BoxJsonFields {
    let ergo_tree_bytes = b.ergo_tree.sigma_serialize_bytes().expect("ErgoTree serialize");

    let tokens: Vec<TokenJson> = b.tokens.as_ref()
        .map(|toks| toks.as_ref() as &[Token])
        .unwrap_or(&[])
        .iter()
        .map(|t| TokenJson {
            id_hex: token_id_hex(&t.token_id),
            amount: u64::from(t.amount).to_string(),
        })
        .collect();

    // NonMandatoryRegisters stores R4..R9; iterate in order.
    let reg_ids = [
        NonMandatoryRegisterId::R4,
        NonMandatoryRegisterId::R5,
        NonMandatoryRegisterId::R6,
        NonMandatoryRegisterId::R7,
        NonMandatoryRegisterId::R8,
        NonMandatoryRegisterId::R9,
    ];
    let mut registers = Vec::new();
    for (idx, reg_id) in reg_ids.iter().enumerate() {
        if let Ok(Some(c)) = b.additional_registers.get_constant(*reg_id) {
            registers.push(RegisterJson {
                id: 4 + idx as u8,
                constant_hex: constant_hex(&c),
            });
        }
    }

    BoxJsonFields {
        value: u64::from(b.value).to_string(),
        ergo_tree_hex: hex::encode(ergo_tree_bytes),
        creation_height: b.creation_height,
        tokens,
        registers,
        tx_id_hex: tx_id_hex(&b.transaction_id),
        index: b.index,
    }
}

// ---------------------------------------------------------------------------
// Entry builders
// ---------------------------------------------------------------------------

/// Entry 1: minimal box — zero tokens, empty registers, value=1_000_000.
fn entry_minimal() -> anyhow::Result<BoxBytesEntry> {
    let value = BoxValue::new(1_000_000u64).expect("BoxValue");
    let tree = minimal_ergo_tree();
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: tree,
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 0,
    };
    let b = ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0x00), 0)
        .expect("ErgoBox minimal");
    Ok(BoxBytesEntry {
        name: "minimal".to_string(),
        description: "Minimal box: value=1_000_000, no tokens, no registers, height=0, index=0, txId=0x00*32".to_string(),
        full_hex: full_hex(&b)?,
        no_ref_hex: no_ref_hex(&b)?,
        box_json: box_json_fields(&b),
    })
}

/// Entry 2: box with 3 tokens, no registers.
fn entry_three_tokens() -> anyhow::Result<BoxBytesEntry> {
    use ergotree_ir::chain::ergo_box::BoxTokens;

    let value = BoxValue::new(2_000_000u64).expect("BoxValue");
    let tree = minimal_ergo_tree();

    let tokens_vec = vec![
        Token { token_id: token_id(0x01), amount: TokenAmount::try_from(100u64).expect("amount") },
        Token { token_id: token_id(0x02), amount: TokenAmount::try_from(200u64).expect("amount") },
        Token { token_id: token_id(0x03), amount: TokenAmount::try_from(300u64).expect("amount") },
    ];
    let box_tokens = BoxTokens::from_vec(tokens_vec).expect("BoxTokens");

    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: tree,
        tokens: Some(box_tokens),
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 100_000,
    };
    let b = ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0xab), 1)
        .expect("ErgoBox 3 tokens");
    Ok(BoxBytesEntry {
        name: "three_tokens".to_string(),
        description: "Box with 3 tokens, no registers, height=100_000, index=1, txId=0xab*32".to_string(),
        full_hex: full_hex(&b)?,
        no_ref_hex: no_ref_hex(&b)?,
        box_json: box_json_fields(&b),
    })
}

/// Entry 3: box with R4 (SInt) and R5 (SBoolean) registers, no tokens.
fn entry_r4_r5() -> anyhow::Result<BoxBytesEntry> {
    let value = BoxValue::new(5_000_000u64).expect("BoxValue");
    let tree = minimal_ergo_tree();

    let r4: Constant = 42i32.into();
    let r5: Constant = true.into();

    let regs = NonMandatoryRegisters::new([
        (NonMandatoryRegisterId::R4, r4),
        (NonMandatoryRegisterId::R5, r5),
    ]).expect("registers R4+R5");

    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: tree,
        tokens: None,
        additional_registers: regs,
        creation_height: 500_000,
    };
    let b = ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0x00), 2)
        .expect("ErgoBox R4+R5");
    Ok(BoxBytesEntry {
        name: "r4_r5_registers".to_string(),
        description: "Box with R4=SInt(42) and R5=SBoolean(true), no tokens, height=500_000, index=2".to_string(),
        full_hex: full_hex(&b)?,
        no_ref_hex: no_ref_hex(&b)?,
        box_json: box_json_fields(&b),
    })
}

/// Entry 4: box with 2 tokens AND R4 (SLong), R5 (SColl[SByte]), R6 (SShort).
fn entry_tokens_and_registers() -> anyhow::Result<BoxBytesEntry> {
    use ergotree_ir::chain::ergo_box::BoxTokens;
    use ergotree_ir::mir::value::{CollKind, NativeColl};
    use ergotree_ir::mir::constant::Literal;
    use std::sync::Arc;

    let value = BoxValue::new(10_000_000u64).expect("BoxValue");
    let tree = minimal_ergo_tree();

    let tokens_vec = vec![
        Token { token_id: token_id(0xaa), amount: TokenAmount::try_from(999u64).expect("amount") },
        Token { token_id: token_id(0xbb), amount: TokenAmount::try_from(1u64).expect("amount") },
    ];
    let box_tokens = BoxTokens::from_vec(tokens_vec).expect("BoxTokens");

    let r4: Constant = 1_234_567_890i64.into();
    let r5_bytes: Vec<i8> = vec![0x01i8, 0x02, 0x03, 0x04, 0x05];
    let r5 = Constant {
        tpe: SType::SColl(Arc::new(SType::SByte)),
        v: Literal::Coll(CollKind::NativeColl(NativeColl::CollByte(r5_bytes.into()))),
    };
    let r6: Constant = 32767i16.into();

    let regs = NonMandatoryRegisters::new([
        (NonMandatoryRegisterId::R4, r4),
        (NonMandatoryRegisterId::R5, r5),
        (NonMandatoryRegisterId::R6, r6),
    ]).expect("registers R4+R5+R6");

    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: tree,
        tokens: Some(box_tokens),
        additional_registers: regs,
        creation_height: 1_000_000,
    };
    let b = ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0xde), 5)
        .expect("ErgoBox tokens+registers");
    Ok(BoxBytesEntry {
        name: "tokens_and_registers".to_string(),
        description: "Box with 2 tokens + R4=SLong, R5=SColl[SByte], R6=SShort, height=1_000_000, index=5, txId=0xde*32".to_string(),
        full_hex: full_hex(&b)?,
        no_ref_hex: no_ref_hex(&b)?,
        box_json: box_json_fields(&b),
    })
}

/// Entry 5: boundary values — value=MAX_RAW, height=i32::MAX, index=u16::MAX, txId=0xff*32.
///
/// creation_height is i32::MAX (0x7fffffff), NOT u32::MAX: the JVM consensus
/// reader `r.getUIntExact` (ErgoBoxCandidate.scala:195) throws for any value >
/// Int.MaxValue, so a u32::MAX height is consensus-invalid. sigma-rust's reader
/// is looser (`r.get_u32()`, ergo_box.rs:433) — the divergence ergots closes;
/// even sigma-rust's proptest generator caps at `0..i32::MAX` (ergo_box.rs:505).
fn entry_boundary() -> anyhow::Result<BoxBytesEntry> {
    let value = BoxValue::new(BoxValue::MAX_RAW).expect("BoxValue max");
    let tree = minimal_ergo_tree();

    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: tree,
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: i32::MAX as u32,
    };
    let b = ErgoBox::from_box_candidate(&candidate, tx_id_from_byte(0xff), u16::MAX)
        .expect("ErgoBox boundary");
    Ok(BoxBytesEntry {
        name: "boundary".to_string(),
        description: "Box at boundary values: value=MAX_RAW, height=i32::MAX, index=u16::MAX, txId=0xff*32".to_string(),
        full_hex: full_hex(&b)?,
        no_ref_hex: no_ref_hex(&b)?,
        box_json: box_json_fields(&b),
    })
}

pub fn generate() -> anyhow::Result<BoxBytesFixture> {
    Ok(BoxBytesFixture {
        entries: vec![
            entry_minimal()?,
            entry_three_tokens()?,
            entry_r4_r5()?,
            entry_tokens_and_registers()?,
            entry_boundary()?,
        ],
    })
}
