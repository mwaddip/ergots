//! Synthetic ErgoTree body / Expr fixtures.
//!
//! Each entry is a name + a textual description + the bytes sigma-rust emits
//! via `Expr::sigma_serialize_bytes()` (which uses tree-version V3 and no
//! constant store, so Const exprs serialize inline). The TS side (Task 30
//! corpus harness) parses each entry via `parseExpr(reader, [], [])` and
//! asserts a byte-for-byte round-trip through `serializeExpr`.
//!
//! Coverage spans one synthetic ErgoTree per opcode group:
//!
//!   - Const (inline) — Int, Long, Boolean, Coll[SByte]
//!   - GlobalVars     — HEIGHT, SELF, INPUTS, OUTPUTS, MINER_PUBKEY, GROUP_GENERATOR
//!   - Context        — CONTEXT
//!   - Global         — GLOBAL
//!   - If             — If(true, 1, 0)
//!   - BinOp arith    — Plus(1, 2), Multiply(2, 3), Minus(10, 4), Divide(20, 5),
//!                       Modulo(7, 3), Max(1, 2), Min(1, 2)
//!   - BinOp relation — Eq(1, 1), NEq(1, 2), Ge(2, 1), Gt(2, 1), Le(1, 2), Lt(1, 2)
//!   - BinOp logical  — BinAnd(true, false), BinOr(true, false), BinXor(true, true)
//!   - BinOp bit      — BitOr(1, 2), BitAnd(1, 3), BitXor(1, 1),
//!                       BitShiftLeft(1, 2), BitShiftRight(8, 2), BitShiftRightZeroed(8, 2)
//!   - And/Or/Xor     — And(Coll[Boolean]), Or(Coll[Boolean]), Xor(Coll[Byte])
//!   - Atleast        — Atleast(2, Coll[SigmaProp])
//!   - LogicalNot     — LogicalNot(true)
//!   - Negation       — Negation(SInt 1)
//!   - BitInversion   — BitInversion(SLong 1)
//!   - Box accessors  — ExtractAmount(SELF), ExtractId(SELF), ExtractScriptBytes(SELF),
//!                       ExtractBytes(SELF), ExtractBytesWithNoRef(SELF),
//!                       ExtractCreationInfo(SELF), ExtractRegisterAs(SELF, R4, Int)
//!   - Collection ops — Collection (Exprs), Collection (BoolConstants),
//!                       SizeOf(MINER_PUBKEY), ByIndex(MINER_PUBKEY, 0, None),
//!                       Append(MINER_PUBKEY, MINER_PUBKEY)
//!   - Tuple          — Tuple of (Int, Boolean)
//!   - SelectField    — SelectField(Tuple, 1)
//!   - BoolToSigmaProp / SigmaPropIsProven / SigmaPropBytes
//!   - BlockValue + ValDef + ValUse
//!   - OptionGet / OptionGetOrElse / OptionIsDefined — via ExtractRegisterAs(SELF, R4, Int)
//!   - CalcBlake2b256 / CalcSha256
//!   - Upcast / Downcast
//!   - DecodePoint
//!   - SigmaAnd / SigmaOr
//!   - LongToByteArray / ByteArrayToLong / ByteArrayToBigInt
//!   - SubstConstants
//!   - DeserializeContext / DeserializeRegister
//!   - MultiplyGroup / Exponentiate
//!   - XorOf
//!   - GetVar
//!
//! Each fixture is the *body alone*; the TS test prepends a synthetic header
//! envelope when checking ErgoTree-level round-trip.

use std::sync::Arc;

use ergo_chain_types::EcPoint;
use ergotree_ir::mir::and::And;
use ergotree_ir::mir::apply::Apply;
use ergotree_ir::mir::atleast::Atleast;
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind, BitOp, LogicalOp, RelationOp};
use ergotree_ir::mir::bit_inversion::BitInversion;
use ergotree_ir::mir::block::BlockValue;
use ergotree_ir::mir::bool_to_sigma::BoolToSigmaProp;
use ergotree_ir::mir::byte_array_to_bigint::ByteArrayToBigInt;
use ergotree_ir::mir::byte_array_to_long::ByteArrayToLong;
use ergotree_ir::mir::calc_blake2b256::CalcBlake2b256;
use ergotree_ir::mir::calc_sha256::CalcSha256;
use ergotree_ir::mir::coll_append::Append;
use ergotree_ir::mir::coll_by_index::ByIndex;
use ergotree_ir::mir::coll_size::SizeOf;
use ergotree_ir::mir::collection::Collection;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::decode_point::DecodePoint;
use ergotree_ir::mir::deserialize_context::DeserializeContext;
use ergotree_ir::mir::deserialize_register::DeserializeRegister;
use ergotree_ir::mir::downcast::Downcast;
use ergotree_ir::mir::exponentiate::Exponentiate;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_amount::ExtractAmount;
use ergotree_ir::mir::extract_bytes::ExtractBytes;
use ergotree_ir::mir::extract_bytes_with_no_ref::ExtractBytesWithNoRef;
use ergotree_ir::mir::extract_creation_info::ExtractCreationInfo;
use ergotree_ir::mir::extract_id::ExtractId;
use ergotree_ir::mir::extract_reg_as::ExtractRegisterAs;
use ergotree_ir::mir::extract_script_bytes::ExtractScriptBytes;
use ergotree_ir::mir::func_value::{FuncArg, FuncValue};
use ergotree_ir::mir::get_var::GetVar;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::mir::if_op::If;
use ergotree_ir::mir::logical_not::LogicalNot;
use ergotree_ir::mir::long_to_byte_array::LongToByteArray;
use ergotree_ir::mir::multiply_group::MultiplyGroup;
use ergotree_ir::mir::negation::Negation;
use ergotree_ir::mir::option_get::OptionGet;
use ergotree_ir::mir::option_get_or_else::OptionGetOrElse;
use ergotree_ir::mir::option_is_defined::OptionIsDefined;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::or::Or;
use ergotree_ir::mir::select_field::{SelectField, TupleFieldIndex};
use ergotree_ir::mir::sigma_and::SigmaAnd;
use ergotree_ir::mir::sigma_or::SigmaOr;
use ergotree_ir::mir::sigma_prop_bytes::SigmaPropBytes;
use ergotree_ir::mir::sigma_prop_is_proven::SigmaPropIsProven;
use ergotree_ir::mir::subst_const::SubstConstants;
use ergotree_ir::mir::tuple::Tuple;
use ergotree_ir::mir::upcast::Upcast;
use ergotree_ir::mir::val_def::{ValDef, ValId};
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::mir::xor::Xor;
use ergotree_ir::mir::xor_of::XorOf;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp};
use ergotree_ir::types::stuple::STuple;
use ergotree_ir::types::stype::SType;
use serde::Serialize;

#[derive(Serialize)]
pub struct ExprEntry {
    pub name: String,
    /// Brief description of the opcode group and what the synthetic tree
    /// exercises. Useful when reading fixture diffs.
    pub description: String,
    /// Body bytes only. The TS side parses this via `parseExpr(reader, [], [])`.
    pub expr_hex: String,
}

#[derive(Serialize)]
pub struct ExprFixtures {
    pub entries: Vec<ExprEntry>,
}

fn entry(name: &str, description: &str, expr: Expr) -> anyhow::Result<ExprEntry> {
    let bytes = expr.sigma_serialize_bytes()?;
    Ok(ExprEntry {
        name: name.to_string(),
        description: description.to_string(),
        expr_hex: hex::encode(bytes),
    })
}

// --- Constant builders ------------------------------------------------------

fn int_const(v: i32) -> Expr {
    Expr::Const(Constant::from(v))
}
fn long_const(v: i64) -> Expr {
    Expr::Const(Constant::from(v))
}
fn bool_const(v: bool) -> Expr {
    Expr::Const(Constant::from(v))
}
fn bytes_const(v: Vec<u8>) -> Expr {
    Expr::Const(Constant::from(v))
}

// --- BinOp wrapper ---------------------------------------------------------

fn bin_op(kind: BinOpKind, left: Expr, right: Expr) -> Expr {
    Expr::BinOp(
        BinOp {
            kind,
            left: Box::new(left),
            right: Box::new(right),
        }
        .into(),
    )
}

// --- Fixture generation -----------------------------------------------------

pub fn generate() -> anyhow::Result<ExprFixtures> {
    let mut entries = Vec::new();

    // === Const (inline) ===
    entries.push(entry(
        "Const SInt 42",
        "inline SInt constant — opcode byte is the SType (0x04), payload is the ZigZag VLQ value",
        int_const(42),
    )?);
    entries.push(entry(
        "Const SLong 1000000",
        "inline SLong constant — opcode 0x05, payload ZigZag VLQ",
        long_const(1_000_000),
    )?);
    entries.push(entry(
        "Const SBoolean true",
        "inline SBoolean constant — emitted as OP_TRUE (0x7f) by the special boolean path",
        bool_const(true),
    )?);
    entries.push(entry(
        "Const SBoolean false",
        "inline SBoolean constant — emitted as OP_FALSE (0x80)",
        bool_const(false),
    )?);
    entries.push(entry(
        "Const SColl[SByte] [1,2,3]",
        "inline byte-array constant — opcode 0x0e (SColl[SByte]), VLQ-u16 length + raw bytes",
        bytes_const(vec![1u8, 2, 3]),
    )?);

    // === GlobalVars (each is a distinct opcode byte) ===
    entries.push(entry(
        "GlobalVars Height",
        "opcode 0xa3 — predefined global HEIGHT (SInt)",
        Expr::GlobalVars(GlobalVars::Height),
    )?);
    entries.push(entry(
        "GlobalVars SelfBox",
        "opcode 0xa7 — predefined global SELF (SBox)",
        Expr::GlobalVars(GlobalVars::SelfBox),
    )?);
    entries.push(entry(
        "GlobalVars Inputs",
        "opcode 0xa4 — predefined global INPUTS (Coll[SBox])",
        Expr::GlobalVars(GlobalVars::Inputs),
    )?);
    entries.push(entry(
        "GlobalVars Outputs",
        "opcode 0xa5 — predefined global OUTPUTS (Coll[SBox])",
        Expr::GlobalVars(GlobalVars::Outputs),
    )?);
    entries.push(entry(
        "GlobalVars MinerPubKey",
        "opcode 0xac — predefined global MINER_PUBKEY (Coll[SByte])",
        Expr::GlobalVars(GlobalVars::MinerPubKey),
    )?);
    entries.push(entry(
        "GlobalVars GroupGenerator",
        "opcode 0x82 — predefined global GROUP_GENERATOR (SGroupElement)",
        Expr::GlobalVars(GlobalVars::GroupGenerator),
    )?);

    // === Context / Global ===
    entries.push(entry(
        "Context",
        "opcode 0xfe — the Context object (SContext)",
        Expr::Context,
    )?);
    entries.push(entry(
        "Global",
        "opcode 0xdd — the Global namespace (SGlobal)",
        Expr::Global,
    )?);

    // === If ===
    entries.push(entry(
        "If(true, 1, 0)",
        "opcode 0x95 — If with three Expr children: condition, true-branch, false-branch",
        Expr::If(If {
            condition: Box::new(bool_const(true)),
            true_branch: Box::new(int_const(1)),
            false_branch: Box::new(int_const(0)),
        }),
    )?);

    // === BinOp Arith ===
    entries.push(entry(
        "BinOp Plus(1, 2)",
        "opcode 0x9a — Plus arith op on two SInt operands",
        bin_op(BinOpKind::Arith(ArithOp::Plus), int_const(1), int_const(2)),
    )?);
    entries.push(entry(
        "BinOp Minus(10, 4)",
        "opcode 0x99 — Minus",
        bin_op(BinOpKind::Arith(ArithOp::Minus), int_const(10), int_const(4)),
    )?);
    entries.push(entry(
        "BinOp Multiply(2, 3)",
        "opcode 0x9c — Multiply",
        bin_op(BinOpKind::Arith(ArithOp::Multiply), int_const(2), int_const(3)),
    )?);
    entries.push(entry(
        "BinOp Divide(20, 5)",
        "opcode 0x9d — Divide",
        bin_op(BinOpKind::Arith(ArithOp::Divide), int_const(20), int_const(5)),
    )?);
    entries.push(entry(
        "BinOp Modulo(7, 3)",
        "opcode 0x9e — Modulo",
        bin_op(BinOpKind::Arith(ArithOp::Modulo), int_const(7), int_const(3)),
    )?);
    entries.push(entry(
        "BinOp Max(1, 2)",
        "opcode 0xa2 — Max",
        bin_op(BinOpKind::Arith(ArithOp::Max), int_const(1), int_const(2)),
    )?);
    entries.push(entry(
        "BinOp Min(1, 2)",
        "opcode 0xa1 — Min",
        bin_op(BinOpKind::Arith(ArithOp::Min), int_const(1), int_const(2)),
    )?);

    // === BinOp Relation ===
    entries.push(entry(
        "BinOp Eq(1, 1)",
        "opcode 0x93 — Eq (returns SBoolean)",
        bin_op(BinOpKind::Relation(RelationOp::Eq), int_const(1), int_const(1)),
    )?);
    entries.push(entry(
        "BinOp NEq(1, 2)",
        "opcode 0x94 — NEq",
        bin_op(BinOpKind::Relation(RelationOp::NEq), int_const(1), int_const(2)),
    )?);
    entries.push(entry(
        "BinOp Ge(2, 1)",
        "opcode 0x92 — Ge",
        bin_op(BinOpKind::Relation(RelationOp::Ge), int_const(2), int_const(1)),
    )?);
    entries.push(entry(
        "BinOp Gt(2, 1)",
        "opcode 0x91 — Gt",
        bin_op(BinOpKind::Relation(RelationOp::Gt), int_const(2), int_const(1)),
    )?);
    entries.push(entry(
        "BinOp Le(1, 2)",
        "opcode 0x90 — Le",
        bin_op(BinOpKind::Relation(RelationOp::Le), int_const(1), int_const(2)),
    )?);
    entries.push(entry(
        "BinOp Lt(1, 2)",
        "opcode 0x8f — Lt",
        bin_op(BinOpKind::Relation(RelationOp::Lt), int_const(1), int_const(2)),
    )?);

    // === BinOp Logical (binary And/Or/Xor on two Booleans) ===
    entries.push(entry(
        "BinOp BinAnd(true, false)",
        "opcode 0xed — binary BinAnd (NOT the And-over-collection opcode 0x96)",
        bin_op(BinOpKind::Logical(LogicalOp::And), bool_const(true), bool_const(false)),
    )?);
    entries.push(entry(
        "BinOp BinOr(true, false)",
        "opcode 0xec — binary BinOr",
        bin_op(BinOpKind::Logical(LogicalOp::Or), bool_const(true), bool_const(false)),
    )?);
    entries.push(entry(
        "BinOp BinXor(true, true)",
        "opcode 0xf4 — binary BinXor",
        bin_op(BinOpKind::Logical(LogicalOp::Xor), bool_const(true), bool_const(true)),
    )?);

    // === BinOp Bit (on SInt operands) ===
    entries.push(entry(
        "BinOp BitOr(1, 2)",
        "opcode 0xf2 — BitOr",
        bin_op(BinOpKind::Bit(BitOp::BitOr), int_const(1), int_const(2)),
    )?);
    entries.push(entry(
        "BinOp BitAnd(1, 3)",
        "opcode 0xf3 — BitAnd",
        bin_op(BinOpKind::Bit(BitOp::BitAnd), int_const(1), int_const(3)),
    )?);
    entries.push(entry(
        "BinOp BitXor(1, 1)",
        "opcode 0xf5 — BitXor",
        bin_op(BinOpKind::Bit(BitOp::BitXor), int_const(1), int_const(1)),
    )?);
    entries.push(entry(
        "BinOp BitShiftLeft(1, 2)",
        "opcode 0xf7 — BitShiftLeft",
        bin_op(BinOpKind::Bit(BitOp::BitShiftLeft), int_const(1), int_const(2)),
    )?);
    entries.push(entry(
        "BinOp BitShiftRight(8, 2)",
        "opcode 0xf6 — BitShiftRight (arithmetic)",
        bin_op(BinOpKind::Bit(BitOp::BitShiftRight), int_const(8), int_const(2)),
    )?);
    entries.push(entry(
        "BinOp BitShiftRightZeroed(8, 2)",
        "opcode 0xf8 — BitShiftRightZeroed (logical)",
        bin_op(BinOpKind::Bit(BitOp::BitShiftRightZeroed), int_const(8), int_const(2)),
    )?);

    // === And / Or / Xor / Atleast ===
    let bool_coll = Expr::Collection(Collection::from_bools(vec![true, false, true]));
    entries.push(entry(
        "And(Coll[Boolean])",
        "opcode 0x96 — And conjunction over a Coll[Boolean] (the BoolConstants variant)",
        Expr::And(
            And {
                input: Box::new(bool_coll.clone()),
            }
            .into(),
        ),
    )?);
    entries.push(entry(
        "Or(Coll[Boolean])",
        "opcode 0x97 — Or disjunction over a Coll[Boolean]",
        Expr::Or(
            Or {
                input: Box::new(bool_coll),
            }
            .into(),
        ),
    )?);
    entries.push(entry(
        "Xor(Coll[Byte], Coll[Byte])",
        "opcode 0x9b — byte-wise XOR of two Coll[SByte]",
        Expr::Xor(Xor {
            left: Box::new(bytes_const(vec![0xaa, 0xaa])),
            right: Box::new(bytes_const(vec![0x55, 0x55])),
        }),
    )?);

    // Atleast needs a SigmaProp collection. Build a ProveDlog SigmaProp constant.
    let sb = make_prove_dlog_sigma_prop();
    let sigma_prop_const = Expr::Const(Constant {
        tpe: SType::SSigmaProp,
        v: ergotree_ir::mir::constant::Literal::SigmaProp(Box::new(sb)),
    });
    let sigma_prop_coll = Expr::Collection(
        Collection::new(SType::SSigmaProp, vec![sigma_prop_const.clone()])
            .expect("Coll[SSigmaProp]"),
    );
    entries.push(entry(
        "Atleast(2, Coll[SigmaProp])",
        "opcode 0x98 — threshold combinator: ≥ N of the SigmaProps in the input collection",
        Expr::Atleast(Atleast {
            bound: Box::new(int_const(2)),
            input: Box::new(sigma_prop_coll),
        }),
    )?);

    // === Unary ops ===
    entries.push(entry(
        "LogicalNot(true)",
        "opcode 0xef — boolean negation",
        Expr::LogicalNot(
            LogicalNot {
                input: Box::new(bool_const(true)),
            }
            .into(),
        ),
    )?);
    entries.push(entry(
        "Negation(SInt 1)",
        "opcode 0xf0 — numeric negation",
        Expr::Negation(
            Negation {
                input: Box::new(int_const(1)),
            }
            .into(),
        ),
    )?);
    entries.push(entry(
        "BitInversion(SLong 1)",
        "opcode 0xf1 — bitwise complement on a numeric value",
        Expr::BitInversion(BitInversion {
            input: Box::new(long_const(1)),
        }),
    )?);

    // === Box accessors (all take SELF as input) ===
    let self_box = Expr::GlobalVars(GlobalVars::SelfBox);
    entries.push(entry(
        "ExtractAmount(SELF)",
        "opcode 0xc1 — SELF.value (SLong)",
        Expr::ExtractAmount(ExtractAmount {
            input: Box::new(self_box.clone()),
        }),
    )?);
    entries.push(entry(
        "ExtractId(SELF)",
        "opcode 0xc5 — SELF.id (Coll[SByte], 32 bytes)",
        Expr::ExtractId(ExtractId {
            input: Box::new(self_box.clone()),
        }),
    )?);
    entries.push(entry(
        "ExtractScriptBytes(SELF)",
        "opcode 0xc2 — SELF.propositionBytes (Coll[SByte])",
        Expr::ExtractScriptBytes(ExtractScriptBytes {
            input: Box::new(self_box.clone()),
        }),
    )?);
    entries.push(entry(
        "ExtractBytes(SELF)",
        "opcode 0xc3 — SELF.bytes (Coll[SByte])",
        Expr::ExtractBytes(ExtractBytes {
            input: Box::new(self_box.clone()),
        }),
    )?);
    entries.push(entry(
        "ExtractBytesWithNoRef(SELF)",
        "opcode 0xc4 — SELF.bytesWithoutRef (Coll[SByte])",
        Expr::ExtractBytesWithNoRef(ExtractBytesWithNoRef {
            input: Box::new(self_box.clone()),
        }),
    )?);
    entries.push(entry(
        "ExtractCreationInfo(SELF)",
        "opcode 0xc7 — SELF.creationInfo ((SInt, Coll[SByte]))",
        Expr::ExtractCreationInfo(ExtractCreationInfo {
            input: Box::new(self_box.clone()),
        }),
    )?);
    entries.push(entry(
        "ExtractRegisterAs(SELF, R4, SOption[SInt])",
        "opcode 0xc6 — SELF.RX[T] (returns SOption[T]); register-id i8 + SType byte",
        Expr::ExtractRegisterAs(
            ExtractRegisterAs::new(
                self_box.clone(),
                4,
                SType::SOption(Arc::new(SType::SInt)),
            )
            .expect("ExtractRegisterAs")
            .into(),
        ),
    )?);

    // === Collection ops ===
    entries.push(entry(
        "Collection Exprs SInt [1,2,3]",
        "opcode 0x83 (COLL) — Collection of three SInt expressions; payload is VLQ-u16 length + SType byte + each Expr",
        Expr::Collection(
            Collection::new(SType::SInt, vec![int_const(1), int_const(2), int_const(3)])
                .expect("Coll Exprs"),
        ),
    )?);
    entries.push(entry(
        "Collection BoolConstants [T,F,T]",
        "opcode 0x85 (COLL_OF_BOOL_CONST) — packed boolean collection; payload is VLQ-u16 length + bit-packed bools",
        Expr::Collection(Collection::from_bools(vec![true, false, true])),
    )?);
    let miner_pk = Expr::GlobalVars(GlobalVars::MinerPubKey);
    entries.push(entry(
        "SizeOf(MINER_PUBKEY)",
        "opcode 0xb1 — Coll.size",
        Expr::SizeOf(SizeOf {
            input: Box::new(miner_pk.clone()),
        }),
    )?);
    entries.push(entry(
        "ByIndex(MINER_PUBKEY, 0, None)",
        "opcode 0xb2 — Coll.apply(index); default branch is Option<Expr> (None here)",
        Expr::ByIndex(
            ByIndex::new(miner_pk.clone(), int_const(0), None)
                .expect("ByIndex")
                .into(),
        ),
    )?);
    entries.push(entry(
        "Append(MINER_PUBKEY, MINER_PUBKEY)",
        "opcode 0xb3 — Coll.append",
        Expr::Append(
            Append::new(miner_pk.clone(), miner_pk.clone())
                .expect("Append")
                .into(),
        ),
    )?);

    // === Tuple + SelectField ===
    let tuple_expr = Expr::Tuple(
        Tuple::new(vec![int_const(1), bool_const(true)])
            .expect("Tuple"),
    );
    entries.push(entry(
        "Tuple(SInt 1, SBoolean true)",
        "opcode 0x86 — Tuple of mixed types; payload is u8 length + each Expr",
        tuple_expr.clone(),
    )?);
    entries.push(entry(
        "SelectField(Tuple, 1)",
        "opcode 0x8c — tuple field selector; field index is 1-based u8",
        Expr::SelectField(
            SelectField::new(
                tuple_expr,
                TupleFieldIndex::try_from(1u8).expect("field index 1"),
            )
            .expect("SelectField")
            .into(),
        ),
    )?);

    // === SigmaProp wrappers ===
    entries.push(entry(
        "BoolToSigmaProp(true)",
        "opcode 0xd1 — wrap an SBoolean into an SSigmaProp",
        Expr::BoolToSigmaProp(BoolToSigmaProp {
            input: Box::new(bool_const(true)),
        }),
    )?);
    entries.push(entry(
        "SigmaPropBytes(ProveDlog)",
        "opcode 0xd0 — serialized bytes of a SigmaProp value",
        Expr::SigmaPropBytes(SigmaPropBytes {
            input: Box::new(sigma_prop_const.clone()),
        }),
    )?);
    entries.push(entry(
        "SigmaPropIsProven(ProveDlog)",
        "opcode 0xcf — SigmaProp.isProven (returns SBoolean)",
        Expr::SigmaPropIsProven(SigmaPropIsProven {
            input: Box::new(sigma_prop_const.clone()),
        }),
    )?);
    entries.push(entry(
        "SigmaAnd([ProveDlog])",
        "opcode 0xea — AND conjunction over a non-empty list of SigmaProps",
        Expr::SigmaAnd(
            SigmaAnd::new(vec![sigma_prop_const.clone()])
                .expect("SigmaAnd"),
        ),
    )?);
    entries.push(entry(
        "SigmaOr([ProveDlog])",
        "opcode 0xeb — OR conjunction over a non-empty list of SigmaProps",
        Expr::SigmaOr(
            SigmaOr::new(vec![sigma_prop_const.clone()])
                .expect("SigmaOr"),
        ),
    )?);

    // === BlockValue + ValDef + ValUse ===
    let val_id_1 = ValId::from(1u32);
    let val_def = Expr::ValDef(
        ValDef {
            id: val_id_1,
            rhs: Box::new(int_const(42)),
        }
        .into(),
    );
    let val_use = Expr::ValUse(ValUse {
        val_id: val_id_1,
        tpe: SType::SInt,
    });
    entries.push(entry(
        "BlockValue([ValDef 1 = 42], ValUse 1)",
        "opcode 0xd8 (BLOCK_VALUE) wrapping ValDef (0xd6) and ValUse (0x72)",
        Expr::BlockValue(
            BlockValue {
                items: vec![val_def],
                result: Box::new(val_use),
            }
            .into(),
        ),
    )?);

    // === Option combinators (via ExtractRegisterAs(SELF, R4, SInt) → SOption[SInt]) ===
    let reg_as_opt_int = ExtractRegisterAs::new(self_box.clone(), 4, SType::SOption(Arc::new(SType::SInt)))
        .expect("ExtractRegisterAs SOption[SInt]");
    let opt_expr: Expr = Expr::ExtractRegisterAs(reg_as_opt_int.clone().into());
    entries.push(entry(
        "OptionGet(SELF.R4[SInt])",
        "opcode 0xe4 — Option.get",
        Expr::OptionGet(
            OptionGet::try_build(opt_expr.clone())
                .expect("OptionGet")
                .into(),
        ),
    )?);
    entries.push(entry(
        "OptionIsDefined(SELF.R4[SInt])",
        "opcode 0xe6 — Option.isDefined (returns SBoolean)",
        Expr::OptionIsDefined(
            OptionIsDefined::try_build(opt_expr.clone())
                .expect("OptionIsDefined")
                .into(),
        ),
    )?);
    entries.push(entry(
        "OptionGetOrElse(SELF.R4[SInt], 0)",
        "opcode 0xe5 — Option.getOrElse(default)",
        Expr::OptionGetOrElse(
            OptionGetOrElse::new(opt_expr, int_const(0))
                .expect("OptionGetOrElse")
                .into(),
        ),
    )?);

    // === Hashes ===
    let bytes_input = bytes_const(vec![0x01, 0x02, 0x03]);
    entries.push(entry(
        "CalcBlake2b256(Coll[Byte])",
        "opcode 0xcb — blake2b256",
        Expr::CalcBlake2b256(CalcBlake2b256 {
            input: Box::new(bytes_input.clone()),
        }),
    )?);
    entries.push(entry(
        "CalcSha256(Coll[Byte])",
        "opcode 0xcc — sha256",
        Expr::CalcSha256(CalcSha256 {
            input: Box::new(bytes_input.clone()),
        }),
    )?);

    // === Upcast / Downcast ===
    entries.push(entry(
        "Upcast(SInt 1, SLong)",
        "opcode 0x7e — numeric widening; target SType follows the opcode",
        Expr::Upcast(
            Upcast::new(int_const(1), SType::SLong).expect("Upcast"),
        ),
    )?);
    entries.push(entry(
        "Downcast(SLong 1, SInt)",
        "opcode 0x7d — numeric narrowing",
        Expr::Downcast(
            Downcast::new(long_const(1), SType::SInt).expect("Downcast"),
        ),
    )?);

    // === DecodePoint ===
    let zero33_bytes = bytes_const(vec![0u8; 33]);
    entries.push(entry(
        "DecodePoint(zeros33)",
        "opcode 0xee — byte-array to GroupElement",
        Expr::DecodePoint(DecodePoint {
            input: Box::new(zero33_bytes),
        }),
    )?);

    // === LongToByteArray / ByteArrayToLong / ByteArrayToBigInt ===
    entries.push(entry(
        "LongToByteArray(SLong 1)",
        "opcode 0x7a — SLong → Coll[SByte]",
        Expr::LongToByteArray(LongToByteArray {
            input: Box::new(long_const(1)),
        }),
    )?);
    entries.push(entry(
        "ByteArrayToLong(Coll[Byte])",
        "opcode 0x7c — Coll[SByte] → SLong",
        Expr::ByteArrayToLong(
            ByteArrayToLong::try_build(bytes_const(vec![0u8; 8]))
                .expect("ByteArrayToLong")
                .into(),
        ),
    )?);
    entries.push(entry(
        "ByteArrayToBigInt(Coll[Byte])",
        "opcode 0x7b — Coll[SByte] → SBigInt",
        Expr::ByteArrayToBigInt(
            ByteArrayToBigInt::try_build(bytes_const(vec![0x01]))
                .expect("ByteArrayToBigInt")
                .into(),
        ),
    )?);

    // === SubstConstants ===
    entries.push(entry(
        "SubstConstants(script, [0], [42])",
        "opcode 0x74 — substitute constants in a serialized script. Three Expr children: script bytes, positions, new values.",
        Expr::SubstConstants(
            SubstConstants {
                script_bytes: Box::new(bytes_const(vec![0u8, 1u8])),
                positions: Box::new(Expr::Collection(
                    Collection::new(SType::SInt, vec![int_const(0)]).expect("Coll positions"),
                )),
                new_values: Box::new(Expr::Collection(
                    Collection::new(SType::SInt, vec![int_const(42)]).expect("Coll values"),
                )),
            }
            .into(),
        ),
    )?);

    // === DeserializeContext / DeserializeRegister ===
    entries.push(entry(
        "DeserializeContext(SInt, varId=1)",
        "opcode 0xd4 — type byte + u8 varId; inlines script from context extension at the given id",
        Expr::DeserializeContext(DeserializeContext {
            tpe: SType::SInt,
            id: 1,
        }),
    )?);
    entries.push(entry(
        "DeserializeRegister(SInt, R4, None)",
        "opcode 0xd5 — type byte + u8 register-id + Option<default>",
        Expr::DeserializeRegister(DeserializeRegister {
            tpe: SType::SInt,
            reg: ergotree_ir::chain::ergo_box::RegisterId::try_from(4u8)
                .expect("R4 in range"),
            default: None,
        }),
    )?);

    // === Group operations ===
    let gen = Expr::GlobalVars(GlobalVars::GroupGenerator);
    entries.push(entry(
        "MultiplyGroup(GROUP_GENERATOR, GROUP_GENERATOR)",
        "opcode 0xa0 — group multiplication of two SGroupElement operands",
        Expr::MultiplyGroup(MultiplyGroup {
            left: Box::new(gen.clone()),
            right: Box::new(gen.clone()),
        }),
    )?);
    entries.push(entry(
        "Exponentiate(GROUP_GENERATOR, BigInt(1))",
        "opcode 0x9f — group exponentiation (SGroupElement, SBigInt) → SGroupElement",
        Expr::Exponentiate(Exponentiate {
            left: Box::new(gen.clone()),
            right: Box::new(Expr::Const(Constant::from(
                ergotree_ir::bigint256::BigInt256::from_be_slice(&[1u8]).unwrap(),
            ))),
        }),
    )?);

    // === XorOf ===
    entries.push(entry(
        "XorOf(Coll[Boolean])",
        "opcode 0xff — XOR of all booleans in the collection",
        Expr::XorOf(XorOf {
            input: Box::new(Expr::Collection(Collection::from_bools(vec![
                true, false, true,
            ]))),
        }),
    )?);

    // === GetVar ===
    entries.push(entry(
        "GetVar[SInt](1)",
        "opcode 0xe3 — context-variable lookup; payload is u8 varId + SType byte",
        Expr::GetVar(
            GetVar {
                var_id: 1u8,
                var_tpe: SType::SInt,
            }
            .into(),
        ),
    )?);

    // === FuncValue + Apply ===
    let func_val_id = ValId::from(2u32);
    let func_value = FuncValue::new(
        vec![FuncArg {
            idx: func_val_id,
            tpe: SType::SInt,
        }],
        bin_op(
            BinOpKind::Arith(ArithOp::Plus),
            Expr::ValUse(ValUse {
                val_id: func_val_id,
                tpe: SType::SInt,
            }),
            int_const(1),
        ),
    );
    entries.push(entry(
        "FuncValue((x:Int) => x + 1)",
        "opcode 0xd9 — user function literal: list of args (id, tpe) + body Expr",
        Expr::FuncValue(func_value.clone()),
    )?);
    entries.push(entry(
        "Apply(FuncValue, [Int 7])",
        "opcode 0xda — function application: callee Expr + arg list",
        Expr::Apply(Apply::new(Expr::FuncValue(func_value), vec![int_const(7)])
            .expect("Apply")),
    )?);

    Ok(ExprFixtures { entries })
}

/// Build a minimal ProveDlog-backed SigmaProp (used by Atleast / SigmaPropBytes /
/// SigmaPropIsProven / SigmaAnd / SigmaOr fixtures).
fn make_prove_dlog_sigma_prop() -> SigmaProp {
    let pk_hex = "02764ea2b0b9b06b5730a4257bba71fd7797eb1ec12bc3ae6025a01d7fba53830e";
    let pk_bytes = hex::decode(pk_hex).expect("hex");
    let ec = EcPoint::sigma_parse_bytes(&pk_bytes).expect("EcPoint");
    let pd = ProveDlog::new(ec);
    let sb = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pd));
    SigmaProp::new(sb)
}

// Convenience trait impl so the BinOp arithmetic helper works on raw Expr.
// (Not strictly needed; included to keep the `bin_op` builder cohesive.)
#[allow(dead_code)]
fn _unused_stuple_keeper(_: &STuple) {}
