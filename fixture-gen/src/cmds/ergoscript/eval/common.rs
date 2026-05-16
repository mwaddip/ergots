//! Shared types for phase 2b eval fixtures.
//!
//! Each per-arm command emits a `EvalFixtureFile` containing a `Vec<EvalFixture>`.
//! Sigma-rust is the oracle: each fixture's `expected_value_json` and
//! `expected_cost` come from running `expr.eval(env, ctx)` against a
//! synthetic Context built from `opts_json`.

use ergotree_ir::chain::ergo_box::ErgoBox;
use ergotree_ir::mir::value::CollKind;
use ergotree_ir::mir::value::NativeColl;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};

#[derive(Serialize)]
pub struct EvalFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    /// EvalOpts for the TS side. Currently `{ jitCostLimit?, constants? }`;
    /// schema grows additively with later phases.
    pub opts_json: JsonValue,
    /// Sigma-rust's Value after eval, encoded as JSON. Schema matches
    /// the SValue hydrator in test/corpus.test.ts.
    pub expected_value_json: JsonValue,
    /// `ctx.jit_cost_value()` after eval.
    pub expected_cost: u64,
}

#[derive(Serialize)]
pub struct EvalFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<EvalFixture>,
}

/// Convenience helper: encode a sigma-rust `Value` as our SValue JSON.
/// Schema mirrors the TS `SValue` discriminated union (see
/// `packages/ergoscript/src/mir/types.ts`):
///   `{ "kind": "<Variant>", "value": <payload> }`
///
/// Long / BigInt are emitted as decimal strings because JSON has no native
/// bigint literal — the TS hydrator (per-test) parses them with `BigInt(...)`.
///
/// Variants are added incrementally per per-arm task: phase-2b primitives
/// (Boolean / Byte / Short / Int / Long / BigInt) land first; composites
/// (Coll / Tuple / Option) are added as Tuple / Collection arm tasks need
/// them; Box / SigmaProp / GroupElement are deferred to phase 2g+.
pub fn value_to_json(v: &Value) -> JsonValue {
    use ergotree_ir::mir::value::Value::*;
    match v {
        Boolean(b) => json!({ "kind": "Boolean", "value": b }),
        Byte(n) => json!({ "kind": "Byte", "value": n }),
        Short(n) => json!({ "kind": "Short", "value": n }),
        Int(n) => json!({ "kind": "Int", "value": n }),
        // i64 / BigInt: emit as decimal string. JSON numbers can't represent
        // |x| > 2^53 - 1 exactly; the TS side rehydrates with BigInt(...).
        Long(n) => json!({ "kind": "Long", "value": n.to_string() }),
        BigInt(b) => json!({ "kind": "BigInt", "value": b.to_string() }),
        // Tuple: heterogeneous fixed-arity. Mirrors `SValue` Tuple variant
        // (`packages/ergoscript/src/mir/types.ts`): `{ kind: "Tuple", items: SValue[] }`.
        // Recurse on each item; per-item encoding (incl. Long/BigInt → string)
        // matches the top-level rules above so the TS hydrator works uniformly.
        Tup(items) => json!({
            "kind": "Tuple",
            "items": items.iter().map(value_to_json).collect::<Vec<_>>(),
        }),
        // Coll: homogeneous collection. Mirrors `SValue` Coll variant
        // (`packages/ergoscript/src/mir/types.ts`):
        //   `{ kind: "Coll", elem: SType, items: SValue[] }`.
        //
        // sigma-rust models the runtime form as a `CollKind` with two arms:
        //   - `WrappedColl { elem_tpe, items }` for the general case
        //   - `NativeColl(NativeColl::CollByte(bytes))` — a packed `Coll[Byte]`
        //     specialization. We unpack the byte-packed form back to a uniform
        //     `Byte`-kinded items list so the TS side sees the same shape no
        //     matter which Rust variant produced it. (`i8` → `i32` widening
        //     to slot into our `{ kind: "Byte", value: number }` schema.)
        Coll(coll_kind) => match coll_kind {
            CollKind::WrappedColl { elem_tpe, items } => json!({
                "kind": "Coll",
                "elem": stype_to_json(elem_tpe),
                "items": items.iter().map(value_to_json).collect::<Vec<_>>(),
            }),
            CollKind::NativeColl(NativeColl::CollByte(bytes)) => json!({
                "kind": "Coll",
                "elem": { "tag": "SByte" },
                "items": bytes
                    .iter()
                    .map(|b| json!({ "kind": "Byte", "value": *b as i32 }))
                    .collect::<Vec<_>>(),
            }),
        },
        // GroupElement: emit 33-byte compressed SEC1 point as hex string.
        // Mirrors the TS `SValue` GroupElement variant:
        //   `{ kind: 'GroupElement', value: Uint8Array }` (hydrated from `bytes_hex`).
        // sigma_serialize_bytes gives the 33-byte compressed form (same as EcPoint wire format).
        Value::GroupElement(pt) => {
            let bytes = pt
                .sigma_serialize_bytes()
                .expect("EcPoint sigma_serialize_bytes");
            json!({ "kind": "GroupElement", "bytes_hex": hex::encode(&bytes) })
        }
        // SigmaProp: emit canonical wire bytes as hex string.
        // `prop_bytes()` calls sigma_serialize_bytes on the constant ErgoTree
        // wrapping the SigmaBoolean — same bytes the TS `SigmaBoolean.raw` field holds.
        Value::SigmaProp(sp) => {
            let bytes = sp
                .prop_bytes()
                .expect("SigmaProp prop_bytes");
            json!({ "kind": "SigmaProp", "raw_hex": hex::encode(&bytes) })
        }
        // Unit: no payload.
        Value::Unit => json!({ "kind": "Unit" }),
        // CBox: emit as structured ErgoBox JSON (phase 2f medium).
        // Mirrors the TS `SValue` Box variant: `{ kind: 'Box', value: ErgoBox }`.
        Value::CBox(b) => json!({ "kind": "Box", "value": ergo_box_to_json(b) }),
        // Other variants extended as later arm tasks need them.
        // Fallback: capture variants we haven't formally encoded yet
        // (AvlTree, Lambda, etc.).
        // Phase 2b's TS arms don't decode these; only used for the
        // mainnet_boxes Layer C2 corpus where value isn't asserted
        // (only cost is, on the eval-able subset). The debug-string
        // representation needs to be stable across regenerations so
        // fixture diffs stay deterministic.
        v => json!({ "kind": "Opaque", "debug": format!("{:?}", v) }),
    }
}

/// Encode an `ErgoBox` as JSON matching the TS `ErgoBox` interface schema.
/// Used by `value_to_json` for `Value::CBox` (phase 2f medium GlobalVars).
///
/// Schema mirrors `packages/ergoscript/src/mir/types.ts::ErgoBox`:
///   - `value_nanoerg`: decimal string (bigint-safe)
///   - `ergo_tree_bytes_hex`: hex-encoded sigma-serialized ergoTree
///   - `tokens`: array of `{ id_hex, amount }` (amount as decimal string)
///   - `registers`: object of register entries (empty for simple boxes)
///   - `creation_height`: u32 number
///   - `tx_id_hex`: hex-encoded 32-byte transaction id
///   - `index`: u16 number
pub fn ergo_box_to_json(b: &ErgoBox) -> JsonValue {
    let ergo_tree_bytes = b.ergo_tree.sigma_serialize_bytes()
        .expect("ergo_tree sigma_serialize_bytes");
    let tokens: Vec<JsonValue> = b.tokens
        .as_ref()
        .map(|ts| ts.iter().map(|t| {
            let id_hex = hex::encode(t.token_id.as_ref());
            let amount: u64 = u64::from(t.amount);
            json!({ "id_hex": id_hex, "amount": amount.to_string() })
        }).collect())
        .unwrap_or_default();
    json!({
        "value_nanoerg": b.value.as_u64().to_string(),
        "ergo_tree_bytes_hex": hex::encode(&ergo_tree_bytes),
        "tokens": tokens,
        "registers": {},
        "creation_height": b.creation_height,
        "tx_id_hex": hex::encode(b.transaction_id.0.0.as_ref()),
        "index": b.index,
    })
}

/// Encode an SType as JSON matching the TS `SType` discriminated union
/// (`packages/ergoscript/src/mir/types.ts`):
///   `{ "tag": "<Variant>" }` for primitives, with a recursive `elem`
///   field for `SColl`. Composite variants used in fixtures are added
///   here as later arm tasks need them.
pub fn stype_to_json(t: &SType) -> JsonValue {
    match t {
        SType::SBoolean => json!({ "tag": "SBoolean" }),
        SType::SByte => json!({ "tag": "SByte" }),
        SType::SShort => json!({ "tag": "SShort" }),
        SType::SInt => json!({ "tag": "SInt" }),
        SType::SLong => json!({ "tag": "SLong" }),
        SType::SBigInt => json!({ "tag": "SBigInt" }),
        SType::SUnit => json!({ "tag": "SUnit" }),
        SType::SAny => json!({ "tag": "SAny" }),
        SType::SColl(elem) => json!({ "tag": "SColl", "elem": stype_to_json(elem) }),
        SType::SOption(elem) => json!({ "tag": "SOption", "elem": stype_to_json(elem) }),
        SType::STuple(items) => json!({
            "tag": "STuple",
            "items": items.items.iter().map(stype_to_json).collect::<Vec<_>>(),
        }),
        SType::SGroupElement => json!({ "tag": "SGroupElement" }),
        SType::SSigmaProp => json!({ "tag": "SSigmaProp" }),
        SType::SBox => json!({ "tag": "SBox" }),
        // Other variants extended as later arm tasks need them.
        _ => panic!("stype_to_json: unsupported variant for phase 2b: {:?}", t),
    }
}
