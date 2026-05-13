//! SType wire-format fixtures.
//!
//! Each entry is a name + a JSON-shape mirroring the TS discriminated union
//! `SType` in `packages/ergoscript/src/mir/types.ts`, plus the bytes
//! sigma-rust emits via `SType::sigma_serialize_bytes()`.
//!
//! Coverage:
//! - all 17 embeddable + non-embeddable primitive variants
//! - SColl[primitive], SColl[non-primitive], SColl[SColl[primitive]] (NESTED_COLL),
//!   SColl[SColl[non-primitive]], SColl[SColl[SColl[primitive]]]
//! - SOption[primitive], SOption[non-primitive], SOption[SColl[primitive]]
//!   (OPTION_COLL), SOption[STuple]
//! - STuple symmetric-pair, asymmetric pair1, pair2, both-non-prim-pair,
//!   triple (3), quadruple (4), and 5-item (length-prefixed TUPLE form)
//! - STypeVar (1-char and 2-char names)
//! - SFunc (Int)=>Boolean, ()=>Unit, (Int,Long)=>Boolean, (T)=>T with tpeParams[T]
//!
//! The `tpeParams[T]` case is constructed by parsing a hand-built byte
//! sequence because `STypeParam` doesn't expose a public constructor;
//! parse → serialize is a fixed-point on well-formed input.

use std::sync::Arc;

use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::sfunc::SFunc;
use ergotree_ir::types::stuple::STuple as RustSTuple;
use ergotree_ir::types::stype::SType;
use ergotree_ir::types::stype_param::STypeVar as RustSTypeVar;
use serde::Serialize;

/// JSON shape of an SType, matching the TS discriminated union in
/// `packages/ergoscript/src/mir/types.ts`. We emit `tag` and per-variant
/// payload using camelCase field names so the TS loader can `as SType`
/// directly.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "tag")]
pub enum JsonSType {
    SBoolean,
    SByte,
    SShort,
    SInt,
    SLong,
    SBigInt,
    SGroupElement,
    SSigmaProp,
    SBox,
    SAvlTree,
    SUnit,
    SAny,
    SHeader,
    SPreHeader,
    SContext,
    SGlobal,
    SString,
    SColl {
        elem: Box<JsonSType>,
    },
    STuple {
        items: Vec<JsonSType>,
    },
    SOption {
        elem: Box<JsonSType>,
    },
    SFunc {
        args: Vec<JsonSType>,
        result: Box<JsonSType>,
        #[serde(rename = "tpeParams")]
        tpe_params: Vec<JsonSTypeVar>,
    },
    STypeVar {
        name: String,
    },
}

#[derive(Serialize, Clone, Debug)]
pub struct JsonSTypeVar {
    pub name: String,
}

/// Convert a sigma-rust `SType` to its JSON-friendly TS-shaped twin.
pub(crate) fn to_json(t: &SType) -> JsonSType {
    match t {
        SType::SBoolean => JsonSType::SBoolean,
        SType::SByte => JsonSType::SByte,
        SType::SShort => JsonSType::SShort,
        SType::SInt => JsonSType::SInt,
        SType::SLong => JsonSType::SLong,
        SType::SBigInt => JsonSType::SBigInt,
        SType::SGroupElement => JsonSType::SGroupElement,
        SType::SSigmaProp => JsonSType::SSigmaProp,
        SType::SBox => JsonSType::SBox,
        SType::SAvlTree => JsonSType::SAvlTree,
        SType::SUnit => JsonSType::SUnit,
        SType::SAny => JsonSType::SAny,
        SType::SHeader => JsonSType::SHeader,
        SType::SPreHeader => JsonSType::SPreHeader,
        SType::SContext => JsonSType::SContext,
        SType::SGlobal => JsonSType::SGlobal,
        SType::SString => JsonSType::SString,
        SType::SColl(inner) => JsonSType::SColl {
            elem: Box::new(to_json(inner)),
        },
        SType::STuple(stuple) => JsonSType::STuple {
            items: stuple.items.iter().map(to_json).collect(),
        },
        SType::SOption(inner) => JsonSType::SOption {
            elem: Box::new(to_json(inner)),
        },
        SType::SFunc(sfunc) => JsonSType::SFunc {
            args: sfunc.t_dom.iter().map(to_json).collect(),
            result: Box::new(to_json(&sfunc.t_range)),
            tpe_params: sfunc
                .tpe_params
                .iter()
                .map(|p| {
                    // STypeParam.ident is pub(crate). Recover the name via
                    // the SFunc serialization round-trip (each tpe_param
                    // serializes as an STypeVar). Cheaper: round-trip
                    // self-serialize once and parse the STypeVar bytes.
                    // The Display impl on STypeVar produces just the name.
                    extract_tpe_param_name(p)
                })
                .collect(),
        },
        SType::STypeVar(tv) => JsonSType::STypeVar {
            name: tv.as_string(),
        },
        // SUnsignedBigInt is v6-only; not in the TS union. We never construct it
        // here, but match exhaustively to catch upstream enum additions.
        SType::SUnsignedBigInt => panic!(
            "SUnsignedBigInt is not in the TS SType union (v6-only); do not emit fixtures for it"
        ),
    }
}

/// Extract the underlying type-variable name out of an `STypeParam`.
///
/// `STypeParam.ident` is `pub(crate)` so we can't read it directly. Cheapest
/// public path: `STypeParam` derives `Debug`, formatting as
/// `STypeParam { ident: "NAME" }` (the inner `STypeVar` `Debug`s as just
/// its name; see `types/stype_param.rs:25-29`). Pluck the quoted NAME.
fn extract_tpe_param_name(p: &ergotree_ir::types::stype_param::STypeParam) -> JsonSTypeVar {
    let dbg = format!("{:?}", p);
    // Format is `STypeParam { ident: "NAME" }` — find the first quoted
    // substring and trim its quotes.
    let start = dbg.find('"').expect("STypeParam debug has a quote");
    let end = dbg.rfind('"').expect("STypeParam debug has a closing quote");
    assert!(end > start, "STypeParam debug must have two distinct quotes");
    JsonSTypeVar {
        name: dbg[start + 1..end].to_string(),
    }
}

#[derive(Serialize)]
pub struct StypeEntry {
    pub name: String,
    pub tpe: JsonSType,
    pub bytes_hex: String,
}

#[derive(Serialize)]
pub struct StypeFixtures {
    pub entries: Vec<StypeEntry>,
}

fn entry(name: &str, t: SType) -> anyhow::Result<StypeEntry> {
    let bytes = t.sigma_serialize_bytes()?;
    Ok(StypeEntry {
        name: name.to_string(),
        tpe: to_json(&t),
        bytes_hex: hex::encode(bytes),
    })
}

// --- Helpers for terse tree construction ------------------------------------

fn coll(inner: SType) -> SType {
    SType::SColl(Arc::new(inner))
}

fn opt(inner: SType) -> SType {
    SType::SOption(Arc::new(inner))
}

fn tup(items: Vec<SType>) -> SType {
    SType::STuple(RustSTuple {
        items: items.try_into().expect("STuple items 2..=255"),
    })
}

fn tv(name: &'static str) -> RustSTypeVar {
    RustSTypeVar::new_from_str(name).expect("STypeVar name length 1..=254")
}

/// Build an SFunc with no type parameters (the common public-API path).
fn func(args: Vec<SType>, result: SType) -> SType {
    SType::SFunc(SFunc::new(args, result))
}

/// Build an SFunc with type parameters via byte-stream round-trip.
///
/// `STypeParam` has no public constructor, so we hand-build the wire form
/// and parse it. The wire encoding (`serialization/types.rs:295-339`) is:
///
///   SFUNC(112) + u8 t_dom_len + each t_dom + serialize(t_range)
///   + u8 tpe_params_len + each tpe_param (each emitted as STypeVar `103 + len + utf8`).
///
/// For tpe-param vars we re-use sigma-rust's `STypeVar::sigma_serialize` to
/// produce `len + utf8` (the leading `103` byte is the type-code stamp that
/// the SFunc reader adds when it emits each param as an SType).
fn func_with_tpe_params(
    args: Vec<SType>,
    result: SType,
    tpe_params: Vec<RustSTypeVar>,
) -> SType {
    let mut bytes: Vec<u8> = vec![112u8, args.len() as u8];
    for a in &args {
        bytes.extend_from_slice(&a.sigma_serialize_bytes().expect("SType serialize"));
    }
    bytes.extend_from_slice(&result.sigma_serialize_bytes().expect("SType serialize"));
    bytes.push(tpe_params.len() as u8);
    for tp in &tpe_params {
        // SFunc serializer emits each tpe-param as a full STypeVar SType:
        // STYPE_VAR(103) + STypeVar payload (u8 len + UTF-8 bytes).
        bytes.push(103u8);
        bytes.extend_from_slice(&serialize_stypevar_payload(tp));
    }
    SType::sigma_parse_bytes(&bytes).expect("hand-built SFunc bytes are well-formed")
}

/// Re-implement `STypeVar::sigma_serialize` payload (len byte + UTF-8 bytes)
/// without going through a `SigmaByteWriter`. The leading `103` type-code is
/// added by the caller (the SFunc serializer).
fn serialize_stypevar_payload(tv: &RustSTypeVar) -> Vec<u8> {
    let name = tv.as_string();
    let utf8 = name.as_bytes();
    let mut v = Vec::with_capacity(1 + utf8.len());
    v.push(utf8.len() as u8);
    v.extend_from_slice(utf8);
    v
}

// --- Fixture generation -----------------------------------------------------

pub fn generate() -> anyhow::Result<StypeFixtures> {
    let mut entries = Vec::new();

    // Embeddable primitives (codes 1..8)
    entries.push(entry("SBoolean", SType::SBoolean)?);
    entries.push(entry("SByte", SType::SByte)?);
    entries.push(entry("SShort", SType::SShort)?);
    entries.push(entry("SInt", SType::SInt)?);
    entries.push(entry("SLong", SType::SLong)?);
    entries.push(entry("SBigInt", SType::SBigInt)?);
    entries.push(entry("SGroupElement", SType::SGroupElement)?);
    entries.push(entry("SSigmaProp", SType::SSigmaProp)?);

    // Non-embeddable primitives (codes 97..106)
    entries.push(entry("SAny", SType::SAny)?);
    entries.push(entry("SUnit", SType::SUnit)?);
    entries.push(entry("SBox", SType::SBox)?);
    entries.push(entry("SAvlTree", SType::SAvlTree)?);
    entries.push(entry("SContext", SType::SContext)?);
    entries.push(entry("SString", SType::SString)?);
    entries.push(entry("SHeader", SType::SHeader)?);
    entries.push(entry("SPreHeader", SType::SPreHeader)?);
    entries.push(entry("SGlobal", SType::SGlobal)?);

    // SColl[primitive] short-form: COLL(12) + primId
    entries.push(entry("SColl[SBoolean]", coll(SType::SBoolean))?);
    entries.push(entry("SColl[SByte]", coll(SType::SByte))?);
    entries.push(entry("SColl[SShort]", coll(SType::SShort))?);
    entries.push(entry("SColl[SInt]", coll(SType::SInt))?);
    entries.push(entry("SColl[SLong]", coll(SType::SLong))?);
    entries.push(entry("SColl[SBigInt]", coll(SType::SBigInt))?);
    entries.push(entry("SColl[SGroupElement]", coll(SType::SGroupElement))?);
    entries.push(entry("SColl[SSigmaProp]", coll(SType::SSigmaProp))?);

    // SColl[SColl[primitive]] nested short-form: NESTED_COLL(24) + primId
    entries.push(entry("SColl[SColl[SByte]]", coll(coll(SType::SByte)))?);
    entries.push(entry("SColl[SColl[SInt]]", coll(coll(SType::SInt)))?);
    entries.push(entry("SColl[SColl[SLong]]", coll(coll(SType::SLong)))?);

    // SColl[non-embeddable]: COLL(12) byte + serialize(inner)
    entries.push(entry("SColl[SBox]", coll(SType::SBox))?);
    entries.push(entry("SColl[SUnit]", coll(SType::SUnit))?);

    // SColl[SColl[non-embeddable]]: COLL(12) + COLL(12) + non-embeddable byte
    entries.push(entry("SColl[SColl[SBox]]", coll(coll(SType::SBox)))?);

    // SColl[SColl[SColl[primitive]]]: COLL(12) + NESTED_COLL(24+primId)
    entries.push(entry(
        "SColl[SColl[SColl[SByte]]]",
        coll(coll(coll(SType::SByte))),
    )?);

    // SOption[primitive] short-form: OPTION(36) + primId
    entries.push(entry("SOption[SBoolean]", opt(SType::SBoolean))?);
    entries.push(entry("SOption[SInt]", opt(SType::SInt))?);
    entries.push(entry("SOption[SLong]", opt(SType::SLong))?);
    entries.push(entry("SOption[SGroupElement]", opt(SType::SGroupElement))?);

    // SOption[SColl[primitive]] short-form: OPTION_COLL(48) + primId
    entries.push(entry("SOption[SColl[SByte]]", opt(coll(SType::SByte)))?);
    entries.push(entry("SOption[SColl[SInt]]", opt(coll(SType::SInt)))?);

    // SOption[non-embeddable]: OPTION(36) + serialize(inner)
    entries.push(entry("SOption[SBox]", opt(SType::SBox))?);
    entries.push(entry("SOption[SAvlTree]", opt(SType::SAvlTree))?);

    // SOption[SColl[non-embeddable]]: OPTION(36) + COLL(12) + non-embeddable byte
    entries.push(entry("SOption[SColl[SBox]]", opt(coll(SType::SBox)))?);

    // SOption[STuple]
    entries.push(entry(
        "SOption[STuple[SInt,SInt]]",
        opt(tup(vec![SType::SInt, SType::SInt])),
    )?);

    // STuple symmetric pair of identical primitives: SYMMETRIC(84) + primId
    entries.push(entry(
        "STuple[SInt,SInt]",
        tup(vec![SType::SInt, SType::SInt]),
    )?);
    entries.push(entry(
        "STuple[SLong,SLong]",
        tup(vec![SType::SLong, SType::SLong]),
    )?);
    entries.push(entry(
        "STuple[SBoolean,SBoolean]",
        tup(vec![SType::SBoolean, SType::SBoolean]),
    )?);

    // STuple pair1: first item is embeddable primitive
    entries.push(entry(
        "STuple[SInt,SBox]",
        tup(vec![SType::SInt, SType::SBox]),
    )?);
    entries.push(entry(
        "STuple[SByte,SLong]",
        tup(vec![SType::SByte, SType::SLong]),
    )?);

    // STuple pair2: only second item is embeddable primitive
    entries.push(entry(
        "STuple[SBox,SInt]",
        tup(vec![SType::SBox, SType::SInt]),
    )?);

    // STuple pair both non-primitive: PAIR1(60) + serialize(t1) + serialize(t2)
    entries.push(entry(
        "STuple[SBox,SAvlTree]",
        tup(vec![SType::SBox, SType::SAvlTree]),
    )?);
    entries.push(entry(
        "STuple[SColl[SLong],SColl[SLong]]",
        tup(vec![coll(SType::SLong), coll(SType::SLong)]),
    )?);

    // STuple triple (3 items): PAIR2(72) + serialize each
    entries.push(entry(
        "STuple[SLong,SLong,SByte]",
        tup(vec![SType::SLong, SType::SLong, SType::SByte]),
    )?);

    // STuple quadruple (4 items): SYMMETRIC(84) + serialize each
    entries.push(entry(
        "STuple[SLong,SLong,SByte,SBoolean]",
        tup(vec![
            SType::SLong,
            SType::SLong,
            SType::SByte,
            SType::SBoolean,
        ]),
    )?);

    // STuple 5 items: TUPLE(96) + u8 length + each
    entries.push(entry(
        "STuple[SLong,SLong,SByte,SBoolean,SInt]",
        tup(vec![
            SType::SLong,
            SType::SLong,
            SType::SByte,
            SType::SBoolean,
            SType::SInt,
        ]),
    )?);

    // STypeVar
    entries.push(entry("STypeVar[T]", SType::STypeVar(tv("T")))?);
    entries.push(entry("STypeVar[IV]", SType::STypeVar(tv("IV")))?);

    // SFunc
    entries.push(entry(
        "SFunc[(SInt)=>SBoolean]",
        func(vec![SType::SInt], SType::SBoolean),
    )?);
    entries.push(entry(
        "SFunc[()=>SUnit]",
        func(vec![], SType::SUnit),
    )?);
    entries.push(entry(
        "SFunc[(SInt,SLong)=>SBoolean]",
        func(vec![SType::SInt, SType::SLong], SType::SBoolean),
    )?);
    entries.push(entry(
        "SFunc[(T)=>T,tpeParams:[T]]",
        func_with_tpe_params(
            vec![SType::STypeVar(tv("T"))],
            SType::STypeVar(tv("T")),
            vec![tv("T")],
        ),
    )?);

    Ok(StypeFixtures { entries })
}
