//! DeserializeRegister arm — oracle fixtures (phase 2i-c T10).
//!
//! Sigma-rust ref:
//!   - `ergotree-ir/src/mir/deserialize_register.rs` — struct {reg, tpe, default}, wire codec
//!   - `ergotree-ir/src/mir/expr.rs:466-491` — `substitute_deserialize` DR branch
//!   - `ergotree-interpreter/src/eval/deserialize_register.rs` (tests-only)
//!   - `ergotree-interpreter/src/eval/expr.rs:102-104` — `Err(EvalError::UnexpectedExpr)`
//!     defensive throw on unsubstituted DeserializeRegister
//!
//! No add_jit_cost in this arm — cost arrives via the inner Expr's (or default's)
//! eval after substitution. Oracle uses `try_eval_with_deserialize::<T>` (runs the
//! substitute pass then `try_eval_out`) for the substitute-then-eval path; the
//! `dr_throw_no_register_no_default` scenario uses `try_eval_out` directly to
//! mirror "leave node unchanged → defensive eval-time throw" semantics.
//!
//! 8 scenarios (PLAN.md Task 10):
//!   Happy:
//!     - dr_r4_bool_neq                       : R4=sigma_serialize(BinOp(NEq, Height, 1i32)); arm.tpe=SBoolean
//!     - dr_r5_default_int                    : R5 absent; default=Const(SInt,1); arm.tpe=SInt
//!     - dr_default_used_when_register_absent : R5 absent; default=BinOp(NEq, Height, 0i32); arm.tpe=SBoolean
//!   Throw:
//!     - dr_throw_register_wrong_type    : R4=Const(SInt,1) (NOT Coll[Byte]) → 'deserialize-input-not-byte-array'
//!     - dr_throw_default_wrong_type     : R5 absent + default=Const(SBoolean,true); arm.tpe=SInt → 'deserialize-tpe-mismatch'
//!     - dr_throw_inner_wrong_type       : R4=sigma_serialize(Const(SInt,1)); arm.tpe=SBoolean → 'deserialize-tpe-mismatch'
//!     - dr_throw_parse_failed           : R4=Coll[Byte] of [0xff,0xff,0xff] → 'deserialize-parse-failed'
//!     - dr_throw_no_register_no_default : R5 absent + default None; arm.tpe=SBoolean → 'deserialize-not-substituted'
//!                                         (special: try_eval_out, not try_eval_with_deserialize — sigma-rust
//!                                          mir/expr.rs:478-481 returns Ok(()) leaving node unchanged → eval-arm throws)

use core::cell::Cell;

use ergo_chain_types::{BlockId, Digest32, EcPoint, PreHeader, Votes};
use ergotree_interpreter::eval::test_util::{try_eval_out, try_eval_with_deserialize};
use ergotree_ir::chain::context::Context;
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::ergo_box::{
    ErgoBox, ErgoBoxCandidate, NonMandatoryRegisterId, NonMandatoryRegisters, RegisterId,
};
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::bin_op::{BinOp, BinOpKind, RelationOp};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::deserialize_register::DeserializeRegister;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;
use sigma_test_util::force_any_val;

use super::common::{stype_to_json, value_to_json};

#[derive(Serialize)]
pub struct DeserializeRegisterFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    /// `{ jitCostLimit?, treeVersion?, height?, selfBox }` — the DR substitute
    /// pass reads `ctx.selfBox.registers[reg]`, so the box (with its sparse
    /// non-mandatory registers populated) is the load-bearing field here.
    pub opts_json: JsonValue,
    /// null for error entries.
    pub expected_value_json: JsonValue,
    /// 0 for error entries.
    pub expected_cost: u64,
    /// Substring expected in `EvalError.message` for throw entries; null for
    /// success. The TS-side messages follow the
    /// `'DeserializeRegister: ...'` template per
    /// packages/ergoscript/src/eval/_substitute-deserialize.ts. The
    /// no-register-no-default case uses a TS-specific substring
    /// ('substitute pass did not rewrite') matching the T3 defensive throw.
    pub expected_error: JsonValue,
    /// null for success entries.
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct DeserializeRegisterFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<DeserializeRegisterFixture>,
}

/// Build a minimal ErgoTree for the box's ergo_tree field (not the outer tree
/// under test — that's `build_outer_tree`). Mirrors `simple_box` precedent in
/// deserialize_context.rs.
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build an ErgoBox carrying the given non-mandatory registers (vec is
/// densely-packed: index 0 → R4, index 1 → R5, ...).
fn box_with_registers(regs_vec: Vec<Constant>) -> ErgoBox {
    let regs = NonMandatoryRegisters::try_from(regs_vec).expect("NonMandatoryRegisters");
    let candidate = ErgoBoxCandidate {
        value: BoxValue::new(BoxValue::MIN_RAW).expect("BoxValue"),
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: regs,
        creation_height: 0,
    };
    ErgoBox::from_box_candidate(&candidate, TxId::zero(), 0).expect("ErgoBox")
}

/// Build a `Const(SColl[SByte], <bytes>)` constant from raw bytes — the
/// caller stores this into a non-mandatory register to feed the substitute
/// pass.
fn coll_byte_constant(bytes: Vec<u8>) -> Constant {
    let signed: Vec<i8> = bytes.into_iter().map(|b| b as i8).collect();
    signed.into()
}

/// Build a controlled `Context<'static>` with the given selfBox and tree
/// version. Mirrors `controlled_context` in deserialize_context.rs but threads
/// the box as the only varying field; ContextExtension is unused for DR (the
/// substitute pass reads `ctx.self_box.get_register` instead).
fn controlled_context(self_box: ErgoBox, version: u8) -> Context<'static> {
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
        height: 999_999,
        miner_pk: Box::new(miner_pk),
        votes: Votes([0, 0, 0]),
    };

    let self_box_ref: &'static ErgoBox = Box::leak(Box::new(self_box));
    // Pre-existing helper precedent (deserialize_context.rs) uses MIN_RAW for
    // unused boxes; same idea here for outputs / inputs.
    let dummy_out: &'static ErgoBox = Box::leak(Box::new(box_with_registers(vec![])));
    let dummy_in: &'static ErgoBox = Box::leak(Box::new(box_with_registers(vec![])));

    Context {
        height: 999_999,
        self_box: self_box_ref,
        outputs: std::slice::from_ref(dummy_out),
        data_inputs: None,
        inputs: vec![dummy_in].try_into().expect("inputs TxIoVec"),
        pre_header,
        headers: base_ctx.headers,
        extension: base_ctx.extension,
        tree_version: Cell::new(ErgoTreeVersion::from(version)),
        extension_provider: base_ctx.extension_provider,
        jit_cost: Cell::new(0),
        jit_cost_limit: None,
        constants: None,
    }
}

/// Build the outer ErgoTree containing a `DeserializeRegister { reg, tpe, default }`
/// expression. `header_byte = 0x00` → V0; `0x03` → V3 (no segregation, no
/// size flag).
fn build_outer_tree(
    reg: RegisterId,
    tpe: SType,
    default: Option<Box<Expr>>,
    header_byte: u8,
) -> anyhow::Result<(ErgoTree, String)> {
    let dr = DeserializeRegister { reg, tpe, default };
    let expr: Expr = dr.into();
    let header = ErgoTreeHeader::new(header_byte)?;
    let tree = ErgoTree::new(header, &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Encode the selfBox's non-mandatory registers as a JSON object keyed by
/// register id (4..=9). Each entry is `{ "tpe": <SType>, "value": <SValue> }`
/// matching the TS `ErgoBox.registers` Record schema
/// (`packages/ergoscript/src/mir/types.ts:82`). Empty registers produce an
/// empty object.
fn registers_to_json(b: &ErgoBox) -> JsonValue {
    let mut obj = serde_json::Map::new();
    for (i, reg_id) in [
        NonMandatoryRegisterId::R4,
        NonMandatoryRegisterId::R5,
        NonMandatoryRegisterId::R6,
        NonMandatoryRegisterId::R7,
        NonMandatoryRegisterId::R8,
        NonMandatoryRegisterId::R9,
    ]
    .iter()
    .enumerate()
    {
        let _ = i;
        // get_constant returns Ok(Some(_)) for present, Ok(None) for absent.
        match b.additional_registers.get_constant(*reg_id) {
            Ok(Some(c)) => {
                let val = Value::from(c.v.clone());
                obj.insert(
                    (*reg_id as u8).to_string(),
                    json!({
                        "tpe": stype_to_json(&c.tpe),
                        "value": value_to_json(&val),
                    }),
                );
            }
            Ok(None) | Err(_) => {}
        }
    }
    JsonValue::Object(obj)
}

/// Encode an ErgoBox as JSON matching the TS `ErgoBox` interface schema, with
/// populated non-mandatory registers. Differs from `common::ergo_box_to_json`
/// (which hardcodes `registers: {}`) by emitting per-register `{tpe, value}`
/// entries. Required by DR fixtures since the substitute pass reads
/// `ctx.selfBox.registers[reg]`.
fn ergo_box_to_json_with_registers(b: &ErgoBox) -> JsonValue {
    let ergo_tree_bytes = b
        .ergo_tree
        .sigma_serialize_bytes()
        .expect("ergo_tree sigma_serialize_bytes");
    let tokens: Vec<JsonValue> = b
        .tokens
        .as_ref()
        .map(|ts| {
            ts.iter()
                .map(|t| {
                    let id_hex = hex::encode(t.token_id.as_ref());
                    let amount: u64 = u64::from(t.amount);
                    json!({ "id_hex": id_hex, "amount": amount.to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "value_nanoerg": b.value.as_u64().to_string(),
        "ergo_tree_bytes_hex": hex::encode(&ergo_tree_bytes),
        "tokens": tokens,
        "registers": registers_to_json(b),
        "creation_height": b.creation_height,
        "tx_id_hex": hex::encode(b.transaction_id.0.0.as_ref()),
        "index": b.index,
    })
}

pub fn generate() -> anyhow::Result<DeserializeRegisterFixtureFile> {
    let mut entries: Vec<DeserializeRegisterFixture> = Vec::new();

    // ─────────────────────────────────────────────────────────────────────────
    // 1. dr_r4_bool_neq — inner=BinOp(NEq, Height, 1i32), arm.tpe=SBoolean.
    //    R4 carries sigma_serialize(inner) as Coll[Byte]; substitute pass
    //    rewrites the arm to the inner Expr, which evaluates to true (height
    //    999_999 != 1).
    // ─────────────────────────────────────────────────────────────────────────
    {
        let inner: Expr = BinOp {
            kind: BinOpKind::Relation(RelationOp::NEq),
            left: Box::new(Expr::GlobalVars(GlobalVars::Height)),
            right: Box::new(Expr::Const(1i32.into())),
        }
        .into();
        let inner_bytes = inner.sigma_serialize_bytes()?;
        let r4_const = coll_byte_constant(inner_bytes);
        let self_box = box_with_registers(vec![r4_const]);

        let (tree, hex) = build_outer_tree(
            NonMandatoryRegisterId::R4.into(),
            SType::SBoolean,
            None,
            0x00,
        )?;
        let ctx = controlled_context(self_box.clone(), 0);
        let outer_expr = tree.proposition()?;
        let val: Value<'static> =
            try_eval_with_deserialize::<Value>(&outer_expr, &ctx)?.to_static();

        entries.push(DeserializeRegisterFixture {
            name: "dr_r4_bool_neq".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": ergo_box_to_json_with_registers(&self_box),
                "height": 999_999,
            }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error: json!(null),
            expected_error_code: json!(null),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. dr_r5_default_int — R5 absent + default=Const(SInt,1); arm.tpe=SInt.
    //    Substitute pass takes the default branch; evaluates to Int(1).
    // ─────────────────────────────────────────────────────────────────────────
    {
        let self_box = box_with_registers(vec![]);
        let default_expr: Expr = Expr::Const(1i32.into());
        let (tree, hex) = build_outer_tree(
            NonMandatoryRegisterId::R5.into(),
            SType::SInt,
            Some(Box::new(default_expr)),
            0x00,
        )?;
        let ctx = controlled_context(self_box.clone(), 0);
        let outer_expr = tree.proposition()?;
        let val: Value<'static> =
            try_eval_with_deserialize::<Value>(&outer_expr, &ctx)?.to_static();

        entries.push(DeserializeRegisterFixture {
            name: "dr_r5_default_int".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": ergo_box_to_json_with_registers(&self_box),
            }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error: json!(null),
            expected_error_code: json!(null),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. dr_default_used_when_register_absent — R5 absent + default is a
    //    non-trivial Expr (BinOp(NEq, Height, 0i32)); arm.tpe=SBoolean.
    //    Substitute pass takes default branch; evaluates to true (Height>0).
    // ─────────────────────────────────────────────────────────────────────────
    {
        let self_box = box_with_registers(vec![]);
        let default_expr: Expr = BinOp {
            kind: BinOpKind::Relation(RelationOp::NEq),
            left: Box::new(Expr::GlobalVars(GlobalVars::Height)),
            right: Box::new(Expr::Const(0i32.into())),
        }
        .into();
        let (tree, hex) = build_outer_tree(
            NonMandatoryRegisterId::R5.into(),
            SType::SBoolean,
            Some(Box::new(default_expr)),
            0x00,
        )?;
        let ctx = controlled_context(self_box.clone(), 0);
        let outer_expr = tree.proposition()?;
        let val: Value<'static> =
            try_eval_with_deserialize::<Value>(&outer_expr, &ctx)?.to_static();

        entries.push(DeserializeRegisterFixture {
            name: "dr_default_used_when_register_absent".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": ergo_box_to_json_with_registers(&self_box),
                "height": 999_999,
            }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error: json!(null),
            expected_error_code: json!(null),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. dr_throw_register_wrong_type — R4=Const(SInt,1) (NOT Coll[Byte]).
    //    Substitute pass throws SubstDeserializeError::TryExtractFrom (sigma)
    //    or ExprTpeError; TS-side throws 'deserialize-input-not-byte-array'.
    // ─────────────────────────────────────────────────────────────────────────
    {
        let r4_const: Constant = 1i32.into();
        let self_box = box_with_registers(vec![r4_const]);
        let (_tree, hex) = build_outer_tree(
            NonMandatoryRegisterId::R4.into(),
            SType::SBoolean,
            None,
            0x00,
        )?;
        // Confirm sigma-rust errors as expected.
        let ctx = controlled_context(self_box.clone(), 0);
        let outer_expr = ErgoTree::new(
            ErgoTreeHeader::v0(false),
            &Expr::from(DeserializeRegister {
                reg: NonMandatoryRegisterId::R4.into(),
                tpe: SType::SBoolean,
                default: None,
            }),
        )?
        .proposition()?;
        let result = try_eval_with_deserialize::<Value>(&outer_expr, &ctx);
        assert!(result.is_err(), "expected throw for wrong register type");

        entries.push(DeserializeRegisterFixture {
            name: "dr_throw_register_wrong_type".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": ergo_box_to_json_with_registers(&self_box),
            }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error: json!("must be Coll[Byte]"),
            expected_error_code: json!("deserialize-input-not-byte-array"),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. dr_throw_default_wrong_type — R5 absent; default=Const(SBoolean,true);
    //    arm.tpe=SInt. Substitute pass's default-tpe check
    //    (expr.rs:486-491) throws ExprTpeError on the SBoolean/SInt mismatch.
    //    TS code: 'deserialize-tpe-mismatch'.
    // ─────────────────────────────────────────────────────────────────────────
    {
        let self_box = box_with_registers(vec![]);
        let default_expr: Expr = Expr::Const(true.into());
        let (_tree, hex) = build_outer_tree(
            NonMandatoryRegisterId::R5.into(),
            SType::SInt,
            Some(Box::new(default_expr.clone())),
            0x00,
        )?;
        // Confirm sigma-rust errors as expected.
        let ctx = controlled_context(self_box.clone(), 0);
        let outer_expr = ErgoTree::new(
            ErgoTreeHeader::v0(false),
            &Expr::from(DeserializeRegister {
                reg: NonMandatoryRegisterId::R5.into(),
                tpe: SType::SInt,
                default: Some(Box::new(default_expr)),
            }),
        )?
        .proposition()?;
        let result = try_eval_with_deserialize::<Value>(&outer_expr, &ctx);
        assert!(
            result.is_err(),
            "expected throw for default wrong type (got {:?})",
            result
        );

        entries.push(DeserializeRegisterFixture {
            name: "dr_throw_default_wrong_type".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": ergo_box_to_json_with_registers(&self_box),
            }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error: json!("tpe mismatch"),
            expected_error_code: json!("deserialize-tpe-mismatch"),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. dr_throw_inner_wrong_type — R4=sigma_serialize(Const(SInt,1));
    //    arm.tpe=SBoolean. Inner parses successfully but tpe mismatches.
    //    TS code: 'deserialize-tpe-mismatch'.
    // ─────────────────────────────────────────────────────────────────────────
    {
        let inner: Expr = Expr::Const(1i32.into());
        let inner_bytes = inner.sigma_serialize_bytes()?;
        let r4_const = coll_byte_constant(inner_bytes);
        let self_box = box_with_registers(vec![r4_const]);
        let (_tree, hex) = build_outer_tree(
            NonMandatoryRegisterId::R4.into(),
            SType::SBoolean,
            None,
            0x00,
        )?;
        // Confirm sigma-rust errors as expected.
        let ctx = controlled_context(self_box.clone(), 0);
        let outer_expr = ErgoTree::new(
            ErgoTreeHeader::v0(false),
            &Expr::from(DeserializeRegister {
                reg: NonMandatoryRegisterId::R4.into(),
                tpe: SType::SBoolean,
                default: None,
            }),
        )?
        .proposition()?;
        let result = try_eval_with_deserialize::<Value>(&outer_expr, &ctx);
        assert!(result.is_err(), "expected throw for inner tpe mismatch");

        entries.push(DeserializeRegisterFixture {
            name: "dr_throw_inner_wrong_type".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": ergo_box_to_json_with_registers(&self_box),
            }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error: json!("tpe mismatch"),
            expected_error_code: json!("deserialize-tpe-mismatch"),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. dr_throw_parse_failed — R4=Coll[Byte] of [0xff,0xff,0xff]
    //    (malformed Expr bytes). TS code: 'deserialize-parse-failed'.
    // ─────────────────────────────────────────────────────────────────────────
    {
        let malformed = vec![0xffu8, 0xffu8, 0xffu8];
        let r4_const = coll_byte_constant(malformed);
        let self_box = box_with_registers(vec![r4_const]);
        let (_tree, hex) = build_outer_tree(
            NonMandatoryRegisterId::R4.into(),
            SType::SBoolean,
            None,
            0x00,
        )?;
        // Confirm sigma-rust errors as expected.
        let ctx = controlled_context(self_box.clone(), 0);
        let outer_expr = ErgoTree::new(
            ErgoTreeHeader::v0(false),
            &Expr::from(DeserializeRegister {
                reg: NonMandatoryRegisterId::R4.into(),
                tpe: SType::SBoolean,
                default: None,
            }),
        )?
        .proposition()?;
        let result = try_eval_with_deserialize::<Value>(&outer_expr, &ctx);
        assert!(
            result.is_err(),
            "expected throw for malformed inner bytes (got {:?})",
            result
        );

        entries.push(DeserializeRegisterFixture {
            name: "dr_throw_parse_failed".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": ergo_box_to_json_with_registers(&self_box),
            }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error: json!("inner Expr parse failed"),
            expected_error_code: json!("deserialize-parse-failed"),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. dr_throw_no_register_no_default — R5 absent + default None;
    //    arm.tpe=SBoolean. SPECIAL: substitute_deserialize (mir/expr.rs:478-481)
    //    returns Ok(()) LEAVING the DeserializeRegister node unchanged in the
    //    tree, then the eval-time defensive throw fires.
    //
    //    Sigma-rust path: try_eval_with_deserialize → substitute_deserialize
    //    returns Ok(unchanged) → try_eval_out → expr.eval → DR arm returns
    //    Err(EvalError::UnexpectedExpr("DeserializeRegister cannot be
    //    evaluated")) (eval/expr.rs:102-104).
    //
    //    We can therefore use either try_eval_out OR try_eval_with_deserialize
    //    here; both produce the same defensive-throw observable. Per PLAN.md
    //    Task 10 we use try_eval_out (no substitute pre-pass) to mirror the
    //    "leave node unchanged" path directly.
    //
    //    TS-side: the substitute pass returns the unchanged node; on
    //    dispatch the T3 defensive throw fires with
    //    'deserialize-not-substituted' and message 'substitute pass did not
    //    rewrite' (see packages/ergoscript/src/eval/arms/_defensive-throws.ts).
    //    The sigma-rust message text differs ("UnexpectedExpr"), but we
    //    capture the TS-friendly substring here since the TS test asserts
    //    against the TS message.
    // ─────────────────────────────────────────────────────────────────────────
    {
        let self_box = box_with_registers(vec![]);
        let (_tree, hex) = build_outer_tree(
            NonMandatoryRegisterId::R5.into(),
            SType::SBoolean,
            None,
            0x00,
        )?;
        // Confirm sigma-rust path errors (defensive eval-time throw via
        // unsubstituted DR arm).
        let ctx = controlled_context(self_box.clone(), 0);
        let outer_expr = ErgoTree::new(
            ErgoTreeHeader::v0(false),
            &Expr::from(DeserializeRegister {
                reg: NonMandatoryRegisterId::R5.into(),
                tpe: SType::SBoolean,
                default: None,
            }),
        )?
        .proposition()?;
        let result = try_eval_out::<Value>(&outer_expr, &ctx);
        assert!(
            result.is_err(),
            "expected throw for no-register-no-default (got {:?})",
            result
        );

        entries.push(DeserializeRegisterFixture {
            name: "dr_throw_no_register_no_default".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": ergo_box_to_json_with_registers(&self_box),
            }),
            expected_value_json: json!(null),
            expected_cost: 0,
            // TS-side defensive-throw substring (the sigma-rust path emits a
            // different "UnexpectedExpr: DeserializeRegister cannot be
            // evaluated" string; we choose the TS one because the TS test
            // asserts against the TS EvalError.message). Match the substring
            // emitted by packages/ergoscript/src/eval/arms/_defensive-throws.ts.
            expected_error: json!("substitute pass did not rewrite"),
            expected_error_code: json!("deserialize-not-substituted"),
        });
    }

    Ok(DeserializeRegisterFixtureFile {
        corpus: "eval_deserialize_register",
        entries,
    })
}
