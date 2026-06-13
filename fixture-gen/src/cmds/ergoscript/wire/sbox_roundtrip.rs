//! SBox wire round-trip fixtures.
//!
//! Each entry contains the full sigma-rust `ErgoBox::sigma_serialize_bytes()`
//! output for a hand-crafted box. The TS side loads each entry's `bytes_hex`,
//! calls `parseSValue({ tag: 'SBox' }, reader)` to parse it, then
//! `serializeSValue({ tag: 'SBox' }, v, writer)` to re-serialize, and asserts
//! byte-for-byte equality with the original.
//!
//! Wire format (sigma-rust `chain/ergo_box.rs:202-223`):
//!   value          — VLQ u64 (BoxValue)
//!   ergo_tree_bytes — ErgoTree::sigma_serialize_bytes() written directly
//!                    (self-delimiting via its own header); v1+ trees include
//!                    hasSize=true so the size is recoverable.
//!   creation_height — VLQ u32 (`put_u32`)
//!   tokens_count    — raw u8 (`put_u8`)
//!   per-token       — 32-byte TokenId + VLQ u64 amount
//!   additional_regs — raw u8 count + per-register: Constant sigma_serialize
//!                    (= SType byte + SValue bytes)
//!   transaction_id  — 32 raw bytes
//!   index           — VLQ u16 (`put_u16`)

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

#[derive(Serialize)]
pub struct SboxRoundtripEntry {
    pub name: String,
    pub description: String,
    pub bytes_hex: String,
}

#[derive(Serialize)]
pub struct SboxRoundtripFixture {
    pub entries: Vec<SboxRoundtripEntry>,
}

/// Build a minimal ErgoTree (v1, no segregation, body = Const(SBoolean true))
/// that produces a compact, known-shape ergoTreeBytes field in the fixture.
///
/// Uses v1 (hasSize=true) so the ergoTree bytes are size-prefixed — this
/// allows the TS SBox parser to know the ergoTree length without a full body
/// parse. All real-world Ergo boxes use v1+ trees with hasSize=true.
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build a 32-byte all-zero TxId.
fn zero_tx_id() -> TxId {
    TxId::zero()
}

/// Build a 32-byte TokenId from a byte value repeated 32 times.
fn token_id(byte: u8) -> TokenId {
    let bytes: [u8; 32] = [byte; 32];
    let digest: ergo_chain_types::Digest32 =
        ergo_chain_types::Digest32::from(bytes);
    digest.into()
}

/// Serialize an ErgoBox to hex.
fn box_to_hex(b: &ErgoBox) -> anyhow::Result<String> {
    let bytes = b.sigma_serialize_bytes()?;
    Ok(hex::encode(bytes))
}

pub fn generate() -> anyhow::Result<SboxRoundtripFixture> {
    let mut entries = Vec::new();

    // -----------------------------------------------------------------------
    // Entry 1: minimal box — zero tokens, empty registers, value=1_000_000
    // -----------------------------------------------------------------------
    {
        let value = BoxValue::new(1_000_000u64).expect("BoxValue");
        let tree = minimal_ergo_tree();
        let candidate = ErgoBoxCandidate {
            value,
            ergo_tree: tree,
            tokens: None,
            additional_registers: NonMandatoryRegisters::empty(),
            creation_height: 0,
        };
        let b = ErgoBox::from_box_candidate(&candidate, zero_tx_id(), 0)
            .expect("ErgoBox minimal");
        entries.push(SboxRoundtripEntry {
            name: "sbox_minimal".to_string(),
            description: "Minimal box: value=1_000_000, no tokens, no registers, height=0, index=0".to_string(),
            bytes_hex: box_to_hex(&b)?,
        });
    }

    // -----------------------------------------------------------------------
    // Entry 2: box with 3 tokens
    // -----------------------------------------------------------------------
    {
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
        let tx_id = {
            let bytes: [u8; 32] = [0xab; 32];
            let digest = ergo_chain_types::Digest32::from(bytes);
            TxId(digest)
        };
        let b = ErgoBox::from_box_candidate(&candidate, tx_id, 1)
            .expect("ErgoBox 3 tokens");
        entries.push(SboxRoundtripEntry {
            name: "sbox_three_tokens".to_string(),
            description: "Box with 3 tokens, no registers, height=100_000, index=1".to_string(),
            bytes_hex: box_to_hex(&b)?,
        });
    }

    // -----------------------------------------------------------------------
    // Entry 3: box with R4 (SInt) and R5 (SBoolean) registers
    // -----------------------------------------------------------------------
    {
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
        let b = ErgoBox::from_box_candidate(&candidate, zero_tx_id(), 2)
            .expect("ErgoBox R4+R5");
        entries.push(SboxRoundtripEntry {
            name: "sbox_r4_r5_registers".to_string(),
            description: "Box with R4=SInt(42) and R5=SBoolean(true), no tokens, height=500_000, index=2".to_string(),
            bytes_hex: box_to_hex(&b)?,
        });
    }

    // -----------------------------------------------------------------------
    // Entry 4: box with 2 tokens AND R4 (SLong), R5 (SColl[SByte]), R6 (SShort)
    // -----------------------------------------------------------------------
    {
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
        let tx_id = {
            let bytes: [u8; 32] = [0xde; 32];
            let digest = ergo_chain_types::Digest32::from(bytes);
            TxId(digest)
        };
        let b = ErgoBox::from_box_candidate(&candidate, tx_id, 5)
            .expect("ErgoBox tokens+registers");
        entries.push(SboxRoundtripEntry {
            name: "sbox_tokens_and_registers".to_string(),
            description: "Box with 2 tokens + R4=SLong, R5=SColl[SByte], R6=SShort, height=1_000_000, index=5".to_string(),
            bytes_hex: box_to_hex(&b)?,
        });
    }

    // -----------------------------------------------------------------------
    // Entry 5: box at boundary conditions (max reasonable size for test coverage):
    //   value = u64::MAX (i64::MAX per BoxValue::MAX_RAW), index=65535, height=i32::MAX
    //
    // creation_height is i32::MAX (0x7fffffff), NOT u32::MAX. The JVM consensus
    // reader is `r.getUIntExact` (ErgoBoxCandidate.scala:195) = `.toIntExact`,
    // which throws an ArithmeticException for any value > Int.MaxValue — so a
    // box with height u32::MAX is consensus-INVALID (the JVM rejects it at
    // parse). sigma-rust's reader is looser (`r.get_u32()`, ergo_box.rs:433,
    // accepts the full u32) which is the divergence ergots closes; even
    // sigma-rust's own proptest generator only emits `0..i32::MAX`
    // (ergo_box.rs:505). i32::MAX is the genuine consensus ceiling, so this
    // boundary fixture exercises the real edge.
    // -----------------------------------------------------------------------
    {
        let value = BoxValue::new(BoxValue::MAX_RAW).expect("BoxValue max");
        let tree = minimal_ergo_tree();

        let candidate = ErgoBoxCandidate {
            value,
            ergo_tree: tree,
            tokens: None,
            additional_registers: NonMandatoryRegisters::empty(),
            creation_height: i32::MAX as u32,
        };
        let tx_id = {
            let bytes: [u8; 32] = [0xff; 32];
            let digest = ergo_chain_types::Digest32::from(bytes);
            TxId(digest)
        };
        let b = ErgoBox::from_box_candidate(&candidate, tx_id, u16::MAX)
            .expect("ErgoBox boundary");
        entries.push(SboxRoundtripEntry {
            name: "sbox_boundary".to_string(),
            description: "Box at boundary values: value=MAX_RAW, height=i32::MAX, index=u16::MAX, txId=0xff*32".to_string(),
            bytes_hex: box_to_hex(&b)?,
        });
    }

    Ok(SboxRoundtripFixture { entries })
}
