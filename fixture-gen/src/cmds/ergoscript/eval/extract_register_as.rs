//! ExtractRegisterAs arm — fixtures for `Expr::ExtractRegisterAs(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/extract_reg_as.rs:15-48`
//!   ctx.add_jit_cost(50)?;                            // BEFORE eval-child (Pattern A)
//!   let ir_box = self.input.eval(env, ctx)?.try_extract_into::<Ref<ErgoBox>>()?;
//!   let id: RegisterId = self.register_id.try_into()?;
//!   let reg = ir_box.get_register(id)?;
//!   match reg {
//!     Some(c) if c.tpe == *self.elem_tpe => Ok(Value::Opt(Some(c.v.into()))),
//!     Some(c) => Err(EvalError::UnexpectedValue(...)),    // type-mismatch THROWS
//!     None => Ok(Value::Opt(None)),
//!   }
//!
//! `ErgoBox::get_register` synthesis (sigma-rust `chain/ergo_box.rs:155-168`):
//!   R0 → SLong   from box.value
//!   R1 → SColl[SByte] from box.script_bytes()
//!   R2 → SColl[STuple[SColl[SByte], SLong]] from box.tokens_raw()
//!   R3 → STuple[SInt, SColl[SByte]] from box.creation_info()
//!   R4..R9 → additional_registers (absent → None)
//!
//! Coverage:
//!   - R0 happy path (elem=SLong): returns Option(Some(Long))
//!   - R1 happy path (elem=SColl[SByte]): returns Option(Some(Coll[Byte]))
//!   - R2 happy path (elem=SColl[STuple[SColl[SByte], SLong]]): box with 1 token
//!   - R3 happy path (elem=STuple[SInt, SColl[SByte]]): returns Option(Some(Tuple))
//!   - R0 type-mismatch (request SInt for SLong register) → 'register-type-mismatch'
//!   - R4 happy path (stored SLong): returns Option(Some(Long))
//!   - R5 happy path (stored SColl[SByte]): returns Option(Some(Coll[Byte]))
//!   - R6 happy path (stored SBoolean): returns Option(Some(Boolean))
//!   - R4 absent (no R4 in box) → Option(None)
//!   - registerId=-1 → 'register-id-out-of-range'
//!   - registerId=10 → 'register-id-out-of-range'
//!   - cost-limit: jitCostLimit=1 < Fixed(50) → 'cost-limit-exceeded'

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::chain::ergo_box::{BoxTokens, ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::token::{Token, TokenAmount, TokenId};
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_reg_as::ExtractRegisterAs;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::{stype_to_json, value_to_json};

#[derive(Serialize)]
pub struct ExtractRegisterAsFixture {
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
pub struct ExtractRegisterAsFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ExtractRegisterAsFixture>,
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

/// Build an `ExtractRegisterAs { input: Const(SBox, box), register_id, elem_tpe }` ErgoTree.
///
/// `elem_tpe` must be passed as `SType::SOption(inner)` — `ExtractRegisterAs::new`
/// unwraps the SOption to get `self.elem_tpe` (the inner type). The TS parser reads
/// just `elem_tpe` from the wire and stores it unwrapped. The fixture serializes the
/// ErgoTree (which encodes `self.elem_tpe` = inner type on the wire); the TS parser
/// reconstructs `registerId` + `elemTpe` correctly.
///
/// `register_id` is an i8: -1 and 10 are out of range (eval error), 0..9 are valid.
fn build_tree(
    ergo_box: ErgoBox,
    register_id: i8,
    elem_tpe_wrapped: SType,
) -> anyhow::Result<(ErgoTree, String)> {
    let box_const: Constant = ergo_box.into();
    let input: Expr = Expr::Const(box_const);
    let node = ExtractRegisterAs::new(input, register_id, elem_tpe_wrapped)
        .map_err(|e| anyhow::anyhow!("ExtractRegisterAs::new: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Construct a simple box: given nanoErg value, empty tokens, empty registers.
fn simple_box(nanoerg: u64) -> ErgoBox {
    let value = BoxValue::new(nanoerg).expect("BoxValue");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 42,
    };
    ErgoBox::from_box_candidate(&candidate, zero_tx_id(), 0).expect("ErgoBox")
}

/// Construct a box with one token.
fn box_with_one_token() -> ErgoBox {
    // Build a known TokenId from a known 32-byte digest (all 0x01).
    let token_id_bytes = [0x01u8; 32];
    let token_id = TokenId::from(
        ergo_chain_types::Digest32::from(token_id_bytes),
    );
    let amount = TokenAmount::try_from(12345u64).expect("TokenAmount");
    let token = Token {
        token_id,
        amount,
    };
    let box_tokens = BoxTokens::from_vec(vec![token]).expect("BoxTokens");
    let value = BoxValue::new(1_000_000).expect("BoxValue");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: Some(box_tokens),
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 7,
    };
    ErgoBox::from_box_candidate(&candidate, zero_tx_id(), 3).expect("ErgoBox")
}

/// Construct a box with additional_registers R4=SLong(9999), R5=SColl[SByte], R6=SBoolean.
fn box_with_extra_registers() -> ErgoBox {
    let value = BoxValue::new(1_000_000).expect("BoxValue");
    // R4: SLong constant
    let r4: Constant = 9999i64.into();
    // R5: SColl[SByte] — a short byte array "deadbeef"
    let r5_bytes: Vec<i8> = vec![0xde_u8 as i8, 0xad_u8 as i8, 0xbe_u8 as i8, 0xef_u8 as i8];
    let r5: Constant = r5_bytes.into();
    // R6: SBoolean(true)
    let r6: Constant = true.into();
    let regs = NonMandatoryRegisters::try_from(vec![r4, r5, r6]).expect("NonMandatoryRegisters");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: regs,
        creation_height: 100,
    };
    ErgoBox::from_box_candidate(&candidate, zero_tx_id(), 1).expect("ErgoBox")
}

/// Construct a box with empty additional_registers (used for absent-register test).
fn box_empty_registers() -> ErgoBox {
    simple_box(10_800)
}

/// Build an Option JSON for the expected_value field.
///
/// `value_to_json` in common.rs doesn't handle `Value::Opt` (the runtime type
/// erases the elem SType). We construct the JSON directly here since we know
/// the elem type from the MIR node.
///
/// Schema matches TS `SValue` Option variant:
///   `{ kind: "Option", elem: SType, value: SValue | null }`
fn option_json(elem_tpe: &SType, inner: Option<JsonValue>) -> JsonValue {
    match inner {
        None => json!({
            "kind": "Option",
            "elem": stype_to_json(elem_tpe),
            "value": null,
        }),
        Some(v) => json!({
            "kind": "Option",
            "elem": stype_to_json(elem_tpe),
            "value": v,
        }),
    }
}

/// Build a success fixture for a register read.
///
/// `register_id`: the register to extract (0..=9).
/// `elem_tpe_inner`: the inner element type (e.g. `SType::SLong`). The fixture-gen
///   wraps it in `SOption` for `ExtractRegisterAs::new` but stores the inner type
///   in the JSON so the TS eval comparison works.
fn success_entry(
    name: &str,
    ergo_box: ErgoBox,
    register_id: i8,
    elem_tpe_inner: SType,
) -> anyhow::Result<ExtractRegisterAsFixture> {
    let wrapped = SType::SOption(elem_tpe_inner.clone().into());
    let (tree, hex) = build_tree(ergo_box, register_id, wrapped)?;
    let ctx = force_any_val::<Context>();
    let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
    // Extract the inner value from the Option result to build the JSON.
    let inner_json = match &val {
        ergotree_ir::mir::value::Value::Opt(None) => None,
        ergotree_ir::mir::value::Value::Opt(Some(boxed)) => Some(value_to_json(boxed)),
        other => anyhow::bail!("expected Value::Opt, got {:?}", other),
    };
    Ok(ExtractRegisterAsFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: option_json(&elem_tpe_inner, inner_json),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Build an error fixture (eval is expected to throw with the given error code).
fn error_entry(
    name: &str,
    ergo_box: ErgoBox,
    register_id: i8,
    elem_tpe_wrapped: SType,
    expected_error_code: &str,
    opts: JsonValue,
) -> anyhow::Result<ExtractRegisterAsFixture> {
    let (_tree, hex) = build_tree(ergo_box, register_id, elem_tpe_wrapped)?;
    Ok(ExtractRegisterAsFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: opts,
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(expected_error_code),
    })
}

pub fn generate() -> anyhow::Result<ExtractRegisterAsFixtureFile> {
    let mut entries = Vec::new();

    // ── R0..R3 mandatory register happy paths ─────────────────────────────────

    // R0: SLong (box.value). Value = box.value as i64.
    entries.push(success_entry(
        "extract_reg_r0_long",
        simple_box(1_000_000_000),
        0,
        SType::SLong,
    )?);

    // R1: SColl[SByte] (box.ergo_tree canonical bytes).
    entries.push(success_entry(
        "extract_reg_r1_coll_byte",
        simple_box(1_000_000_000),
        1,
        SType::SColl(SType::SByte.into()),
    )?);

    // R2: SColl[STuple[SColl[SByte], SLong]] (box.tokens_raw). Box with 1 token.
    {
        use ergotree_ir::types::stuple::STuple;
        let inner_tuple = SType::STuple(STuple::pair(
            SType::SColl(SType::SByte.into()),
            SType::SLong,
        ).into());
        entries.push(success_entry(
            "extract_reg_r2_coll_tuple_tokens",
            box_with_one_token(),
            2,
            SType::SColl(inner_tuple.into()),
        )?);
    }

    // R3: STuple[SInt, SColl[SByte]] (box.creation_info = (height, txId ++ index)).
    {
        use ergotree_ir::types::stuple::STuple;
        entries.push(success_entry(
            "extract_reg_r3_tuple_creation_info",
            simple_box(500_000),
            3,
            SType::STuple(STuple::pair(
                SType::SInt,
                SType::SColl(SType::SByte.into()),
            ).into()),
        )?);
    }

    // ── R0 type-mismatch ──────────────────────────────────────────────────────

    // R0 is SLong, but we ask for SInt → EvalError::UnexpectedValue.
    entries.push(error_entry(
        "extract_reg_r0_type_mismatch",
        simple_box(1_000_000_000),
        0,
        SType::SOption(SType::SInt.into()),
        "register-type-mismatch",
        json!({}),
    )?);

    // ── R4..R9 non-mandatory register happy paths ─────────────────────────────

    // R4: SLong(9999) from box with extra registers.
    entries.push(success_entry(
        "extract_reg_r4_long",
        box_with_extra_registers(),
        4,
        SType::SLong,
    )?);

    // R5: SColl[SByte] ([0xde, 0xad, 0xbe, 0xef]) from box with extra registers.
    entries.push(success_entry(
        "extract_reg_r5_coll_byte",
        box_with_extra_registers(),
        5,
        SType::SColl(SType::SByte.into()),
    )?);

    // R6: SBoolean(true) from box with extra registers.
    entries.push(success_entry(
        "extract_reg_r6_boolean",
        box_with_extra_registers(),
        6,
        SType::SBoolean,
    )?);

    // ── Absent non-mandatory register → Option(None) ──────────────────────────

    // R4 not set in box_empty_registers → Option(None). Elem type is SLong (any is fine).
    entries.push(success_entry(
        "extract_reg_r4_absent",
        box_empty_registers(),
        4,
        SType::SLong,
    )?);

    // ── registerId out-of-range ───────────────────────────────────────────────

    // registerId = -1 → 'register-id-out-of-range'.
    // Note: ExtractRegisterAs::new accepts any i8 at construction time;
    // the range check fires at eval time (RegisterId::try_from(i8) in extract_reg_as.rs:27).
    entries.push(error_entry(
        "extract_reg_id_negative",
        simple_box(1_000_000_000),
        -1,
        SType::SOption(SType::SLong.into()),
        "register-id-out-of-range",
        json!({}),
    )?);

    // registerId = 10 → 'register-id-out-of-range' (END_INDEX = 9 for R9).
    entries.push(error_entry(
        "extract_reg_id_too_large",
        simple_box(1_000_000_000),
        10,
        SType::SOption(SType::SLong.into()),
        "register-id-out-of-range",
        json!({}),
    )?);

    // ── Cost-limit ────────────────────────────────────────────────────────────

    // jitCostLimit=1 < Fixed(50) — addCost(50) fires immediately (Pattern A).
    entries.push(error_entry(
        "extract_reg_cost_limit_exceeded",
        simple_box(1_000_000_000),
        0,
        SType::SOption(SType::SLong.into()),
        "cost-limit-exceeded",
        json!({ "jitCostLimit": 1 }),
    )?);

    Ok(ExtractRegisterAsFixtureFile {
        corpus: "eval_extract_register_as",
        entries,
    })
}
