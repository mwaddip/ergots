//! SValue wire-format fixtures.
//!
//! Each entry is a name + an SType + the JSON-shape of the corresponding
//! TS `SValue` discriminated union + the bytes sigma-rust emits via
//! `DataSerializer::sigma_serialize` (which excludes the SType prefix, so
//! the bytes match what the TS `serializeSValue` writes).
//!
//! Coverage mirrors `packages/ergoscript/test/svalue.test.ts` (the inline
//! cases) plus a handful of edge cases for `SColl[SByte]`, `SColl[SBoolean]`
//! (bit-packed), `SBigInt` (positive/negative/sign-extension boundary),
//! `SOption` Some/None, `STuple` of 2/3/4/5 items.
//!
//! Tree version is pinned to V3 (MAX_SCRIPT_VERSION) so SOption / SHeader
//! are emitted via the V3 encoding (1-byte tag + inner for Some, 0 for None).

use std::sync::Arc;

use ergo_chain_types::EcPoint;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::ergo_tree::ErgoTreeVersion;
use ergotree_ir::mir::constant::Literal;
use ergotree_ir::mir::value::{CollKind, NativeColl};
use ergotree_ir::serialization::data::DataSerializer;
use ergotree_ir::serialization::sigma_byte_writer::{SigmaByteWrite, SigmaByteWriter};
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp};
use ergotree_ir::types::stuple::STuple as RustSTuple;
use ergotree_ir::types::stype::SType;
use serde::Serialize;

use super::synthetic_stype::{to_json as stype_to_json, JsonSType};

/// JSON shape of an SValue, mirroring the TS discriminated union in
/// `packages/ergoscript/src/mir/types.ts`. We emit `kind` and per-variant
/// payload so the TS loader can use it directly.
///
/// Numeric values that fit in JS `number` (Byte, Short, Int) emit as JSON
/// numbers; `Long` and `BigInt` emit as decimal strings (JSON has no
/// 64-bit-safe integer or bigint literal). Byte arrays emit as lower-case
/// hex strings (`bytes_hex`). The TS loader is expected to convert these
/// at load time.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind")]
pub enum JsonSValue {
    Boolean { value: bool },
    Byte { value: i8 },
    Short { value: i16 },
    Int { value: i32 },
    /// Long values are emitted as decimal strings because JSON numbers cannot
    /// represent the full i64 range losslessly.
    Long {
        #[serde(rename = "value")]
        value_str: String,
    },
    /// BigInt values are emitted as decimal strings too.
    BigInt {
        #[serde(rename = "value")]
        value_str: String,
    },
    GroupElement {
        /// 33-byte SEC1-compressed point (or 33 zero bytes for identity).
        bytes_hex: String,
    },
    Unit,
    SigmaProp {
        /// Raw on-wire bytes of the sigma proposition. The TS side keeps
        /// these opaque (`SigmaBoolean.raw: Uint8Array`) until phase 2g.
        raw_hex: String,
    },
    Coll {
        elem: JsonSType,
        items: Vec<JsonSValue>,
    },
    Tuple {
        items: Vec<JsonSValue>,
    },
    Option {
        elem: JsonSType,
        /// `null` for None, the inner SValue for Some.
        value: Option<Box<JsonSValue>>,
    },
}

impl JsonSValue {
    /// Convert a sigma-rust `Literal` (paired with its `SType` to disambiguate
    /// empty collections / None options) to its TS-shaped JSON twin.
    pub(crate) fn from_literal(tpe: &SType, lit: &Literal) -> Self {
        match (tpe, lit) {
            (SType::SBoolean, Literal::Boolean(v)) => JsonSValue::Boolean { value: *v },
            (SType::SByte, Literal::Byte(v)) => JsonSValue::Byte { value: *v },
            (SType::SShort, Literal::Short(v)) => JsonSValue::Short { value: *v },
            (SType::SInt, Literal::Int(v)) => JsonSValue::Int { value: *v },
            (SType::SLong, Literal::Long(v)) => JsonSValue::Long {
                value_str: v.to_string(),
            },
            (SType::SBigInt, Literal::BigInt(v)) => JsonSValue::BigInt {
                value_str: format!("{}", v),
            },
            (SType::SGroupElement, Literal::GroupElement(ecp)) => {
                let bytes = ecp
                    .sigma_serialize_bytes()
                    .expect("EcPoint serialize");
                JsonSValue::GroupElement {
                    bytes_hex: hex::encode(bytes),
                }
            }
            (SType::SUnit, Literal::Unit) => JsonSValue::Unit,
            (SType::SSigmaProp, Literal::SigmaProp(sp)) => {
                let raw = sp
                    .value()
                    .sigma_serialize_bytes()
                    .expect("SigmaBoolean serialize");
                JsonSValue::SigmaProp {
                    raw_hex: hex::encode(raw),
                }
            }
            (SType::SColl(elem_tpe), Literal::Coll(coll)) => {
                let items: Vec<JsonSValue> = match coll {
                    CollKind::NativeColl(NativeColl::CollByte(bytes)) => bytes
                        .iter()
                        .map(|b| JsonSValue::Byte { value: *b })
                        .collect(),
                    CollKind::WrappedColl { elem_tpe, items } => items
                        .iter()
                        .map(|l| JsonSValue::from_literal(elem_tpe, l))
                        .collect(),
                };
                JsonSValue::Coll {
                    elem: stype_to_json(elem_tpe),
                    items,
                }
            }
            (SType::STuple(RustSTuple { items: item_types }), Literal::Tup(item_vals)) => {
                let items = item_types
                    .iter()
                    .zip(item_vals.iter())
                    .map(|(t, v)| JsonSValue::from_literal(t, v))
                    .collect();
                JsonSValue::Tuple { items }
            }
            (SType::SOption(inner_tpe), Literal::Opt(opt)) => JsonSValue::Option {
                elem: stype_to_json(inner_tpe),
                value: opt.as_ref().map(|boxed| {
                    Box::new(JsonSValue::from_literal(inner_tpe, boxed.as_ref()))
                }),
            },
            _ => panic!(
                "JsonSValue::from_literal: unhandled (tpe={:?}, lit={:?})",
                tpe, lit
            ),
        }
    }
}

#[derive(Serialize)]
pub struct SvalueEntry {
    pub name: String,
    pub tpe: JsonSType,
    pub value: JsonSValue,
    pub bytes_hex: String,
}

#[derive(Serialize)]
pub struct SvalueFixtures {
    pub entries: Vec<SvalueEntry>,
}

/// Serialize a `Literal` to its on-wire bytes (no SType prefix) at tree
/// version V3 (so SOption / SHeader use their V3 encodings).
fn serialize_lit(lit: &Literal) -> anyhow::Result<Vec<u8>> {
    let mut data: Vec<u8> = Vec::new();
    let mut w = SigmaByteWriter::new(&mut data, None);
    w.with_tree_version(ErgoTreeVersion::MAX_SCRIPT_VERSION, |w| {
        DataSerializer::sigma_serialize(lit, w)
    })?;
    Ok(data)
}

fn entry(name: &str, tpe: SType, lit: Literal) -> anyhow::Result<SvalueEntry> {
    let bytes = serialize_lit(&lit)?;
    let value = JsonSValue::from_literal(&tpe, &lit);
    Ok(SvalueEntry {
        name: name.to_string(),
        tpe: stype_to_json(&tpe),
        value,
        bytes_hex: hex::encode(bytes),
    })
}

fn coll_t(inner: SType) -> SType {
    SType::SColl(Arc::new(inner))
}

fn opt_t(inner: SType) -> SType {
    SType::SOption(Arc::new(inner))
}

fn tup_t(items: Vec<SType>) -> SType {
    SType::STuple(RustSTuple {
        items: items.try_into().expect("STuple items 2..=255"),
    })
}

/// Build a Literal::Coll of bytes from a raw byte slice (NativeColl path).
fn coll_bytes_lit(bytes: &[i8]) -> Literal {
    Literal::Coll(CollKind::NativeColl(NativeColl::CollByte(Arc::from(bytes))))
}

/// Build a WrappedColl Literal (for non-byte element types).
fn wrapped_coll_lit(elem_tpe: SType, items: Vec<Literal>) -> Literal {
    Literal::Coll(CollKind::WrappedColl {
        elem_tpe,
        items: items.into(),
    })
}

fn tuple_lit(items: Vec<Literal>) -> Literal {
    Literal::Tup(items.try_into().expect("Tuple arity 2..=255"))
}

fn opt_some(inner: Literal) -> Literal {
    Literal::Opt(Some(Box::new(inner)))
}

fn opt_none() -> Literal {
    Literal::Opt(None)
}

// --- Fixture generation -----------------------------------------------------

pub fn generate() -> anyhow::Result<SvalueFixtures> {
    let mut entries = Vec::new();

    // SBoolean — 1 byte
    entries.push(entry("SBoolean true", SType::SBoolean, Literal::Boolean(true))?);
    entries.push(entry("SBoolean false", SType::SBoolean, Literal::Boolean(false))?);

    // SByte — 1 raw byte (two's complement i8)
    entries.push(entry("SByte 0", SType::SByte, Literal::Byte(0))?);
    entries.push(entry("SByte 1", SType::SByte, Literal::Byte(1))?);
    entries.push(entry("SByte -1", SType::SByte, Literal::Byte(-1))?);
    entries.push(entry("SByte 127", SType::SByte, Literal::Byte(127))?);
    entries.push(entry("SByte -128", SType::SByte, Literal::Byte(-128))?);

    // SShort — ZigZag VLQ (via i32 path) on the wire
    entries.push(entry("SShort 0", SType::SShort, Literal::Short(0))?);
    entries.push(entry("SShort 1", SType::SShort, Literal::Short(1))?);
    entries.push(entry("SShort -1", SType::SShort, Literal::Short(-1))?);
    entries.push(entry("SShort 64", SType::SShort, Literal::Short(64))?);
    entries.push(entry("SShort i16::MAX", SType::SShort, Literal::Short(i16::MAX))?);
    entries.push(entry("SShort i16::MIN", SType::SShort, Literal::Short(i16::MIN))?);

    // SInt — ZigZag VLQ
    entries.push(entry("SInt 0", SType::SInt, Literal::Int(0))?);
    entries.push(entry("SInt 42", SType::SInt, Literal::Int(42))?);
    entries.push(entry("SInt -1", SType::SInt, Literal::Int(-1))?);
    entries.push(entry("SInt i32::MAX", SType::SInt, Literal::Int(i32::MAX))?);
    entries.push(entry("SInt i32::MIN", SType::SInt, Literal::Int(i32::MIN))?);

    // SLong — ZigZag VLQ i64
    entries.push(entry("SLong 0", SType::SLong, Literal::Long(0))?);
    entries.push(entry("SLong 1", SType::SLong, Literal::Long(1))?);
    entries.push(entry("SLong -1", SType::SLong, Literal::Long(-1))?);
    entries.push(entry("SLong i64::MAX", SType::SLong, Literal::Long(i64::MAX))?);
    entries.push(entry("SLong i64::MIN", SType::SLong, Literal::Long(i64::MIN))?);

    // SBigInt — VLQ-u16 length + big-endian minimal-byte two's-complement
    entries.push(entry(
        "SBigInt 0",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[0u8]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt 1",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[1u8]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt 127",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[127u8]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt 128",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[0u8, 128u8]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt 255",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[0u8, 255u8]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt 256",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[1u8, 0u8]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt -1",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[0xffu8]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt -128",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[0x80u8]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt -129",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[0xff, 0x7f]).unwrap()),
    )?);
    entries.push(entry(
        "SBigInt -256",
        SType::SBigInt,
        Literal::BigInt(BigInt256::from_be_slice(&[0xff, 0x00]).unwrap()),
    )?);

    // SGroupElement — 33 raw bytes (SEC1-compressed) or 33 zeros for identity
    let mut compressed_pk = vec![0u8; 33];
    compressed_pk[0] = 0x02;
    for b in compressed_pk.iter_mut().skip(1) {
        *b = 0xab;
    }
    let ec_compressed = EcPoint::sigma_parse_bytes(&compressed_pk)?;
    entries.push(entry(
        "SGroupElement compressed",
        SType::SGroupElement,
        Literal::GroupElement(Arc::new(ec_compressed)),
    )?);

    let identity_bytes = vec![0u8; 33];
    let ec_identity = EcPoint::sigma_parse_bytes(&identity_bytes)?;
    entries.push(entry(
        "SGroupElement infinity",
        SType::SGroupElement,
        Literal::GroupElement(Arc::new(ec_identity)),
    )?);

    // SUnit — 0 bytes
    entries.push(entry("SUnit", SType::SUnit, Literal::Unit)?);

    // SSigmaProp — minimal ProveDlog (opcode 0xcd + 33-byte SEC1 pubkey).
    // The TS side keeps the raw bytes opaque; we round-trip a ProveDlog
    // built from the same EC point we serialized above.
    let prove_dlog_pk_hex = "02764ea2b0b9b06b5730a4257bba71fd7797eb1ec12bc3ae6025a01d7fba53830e";
    let prove_dlog_pk_bytes = hex::decode(prove_dlog_pk_hex)?;
    let prove_dlog_ec = EcPoint::sigma_parse_bytes(&prove_dlog_pk_bytes)?;
    let prove_dlog = ergotree_ir::sigma_protocol::sigma_boolean::ProveDlog::new(prove_dlog_ec);
    let sb = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(prove_dlog));
    let sp = SigmaProp::new(sb);
    entries.push(entry(
        "SSigmaProp ProveDlog",
        SType::SSigmaProp,
        Literal::SigmaProp(Box::new(sp)),
    )?);

    // SColl[SInt] — generic Coll path. Empty + 3-element.
    entries.push(entry(
        "SColl[SInt] []",
        coll_t(SType::SInt),
        wrapped_coll_lit(SType::SInt, vec![]),
    )?);
    entries.push(entry(
        "SColl[SInt] [1,2,3]",
        coll_t(SType::SInt),
        wrapped_coll_lit(
            SType::SInt,
            vec![Literal::Int(1), Literal::Int(2), Literal::Int(3)],
        ),
    )?);

    // SColl[SByte] — NativeColl path. Empty + 4-element.
    entries.push(entry(
        "SColl[SByte] empty",
        coll_t(SType::SByte),
        coll_bytes_lit(&[]),
    )?);
    entries.push(entry(
        "SColl[SByte] [0x00, 0xff, 0x7f, 0x80]",
        coll_t(SType::SByte),
        coll_bytes_lit(&[0, -1, 127, -128]),
    )?);

    // SColl[SBoolean] — bit-packed LSB-first. 5 bools + 9 bools (length boundary).
    entries.push(entry(
        "SColl[SBoolean] [T,F,T,T,F]",
        coll_t(SType::SBoolean),
        wrapped_coll_lit(
            SType::SBoolean,
            vec![
                Literal::Boolean(true),
                Literal::Boolean(false),
                Literal::Boolean(true),
                Literal::Boolean(true),
                Literal::Boolean(false),
            ],
        ),
    )?);
    entries.push(entry(
        "SColl[SBoolean] 9 elems (cross byte boundary)",
        coll_t(SType::SBoolean),
        wrapped_coll_lit(
            SType::SBoolean,
            (0..9)
                .map(|i| Literal::Boolean(i == 8))
                .collect(),
        ),
    )?);

    // SColl[SColl[SInt]] nested — [[1], [], [2, 3]]
    entries.push(entry(
        "SColl[SColl[SInt]] [[1],[],[2,3]]",
        coll_t(coll_t(SType::SInt)),
        wrapped_coll_lit(
            coll_t(SType::SInt),
            vec![
                wrapped_coll_lit(SType::SInt, vec![Literal::Int(1)]),
                wrapped_coll_lit(SType::SInt, vec![]),
                wrapped_coll_lit(SType::SInt, vec![Literal::Int(2), Literal::Int(3)]),
            ],
        ),
    )?);

    // SOption[SInt] — V3+ encoding: 1-byte tag + (Some ? inner : nothing).
    entries.push(entry(
        "SOption[SInt] None",
        opt_t(SType::SInt),
        opt_none(),
    )?);
    entries.push(entry(
        "SOption[SInt] Some(42)",
        opt_t(SType::SInt),
        opt_some(Literal::Int(42)),
    )?);

    // STuple — no length prefix; arity comes from the SType.
    entries.push(entry(
        "STuple[SInt,SBoolean] (1,true)",
        tup_t(vec![SType::SInt, SType::SBoolean]),
        tuple_lit(vec![Literal::Int(1), Literal::Boolean(true)]),
    )?);
    entries.push(entry(
        "STuple[SInt,SInt,SInt] (1,2,3)",
        tup_t(vec![SType::SInt, SType::SInt, SType::SInt]),
        tuple_lit(vec![Literal::Int(1), Literal::Int(2), Literal::Int(3)]),
    )?);
    entries.push(entry(
        "STuple[SByte x4] (1,2,3,4)",
        tup_t(vec![SType::SByte, SType::SByte, SType::SByte, SType::SByte]),
        tuple_lit(vec![
            Literal::Byte(1),
            Literal::Byte(2),
            Literal::Byte(3),
            Literal::Byte(4),
        ]),
    )?);
    entries.push(entry(
        "STuple[SBoolean x5] (T,F,T,F,T)",
        tup_t(vec![
            SType::SBoolean,
            SType::SBoolean,
            SType::SBoolean,
            SType::SBoolean,
            SType::SBoolean,
        ]),
        tuple_lit(vec![
            Literal::Boolean(true),
            Literal::Boolean(false),
            Literal::Boolean(true),
            Literal::Boolean(false),
            Literal::Boolean(true),
        ]),
    )?);

    Ok(SvalueFixtures { entries })
}
