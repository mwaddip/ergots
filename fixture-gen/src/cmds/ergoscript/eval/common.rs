//! Shared types for phase 2b eval fixtures.
//!
//! Each per-arm command emits a `EvalFixtureFile` containing a `Vec<EvalFixture>`.
//! Sigma-rust is the oracle: each fixture's `expected_value_json` and
//! `expected_cost` come from running `expr.eval(env, ctx)` against a
//! synthetic Context built from `opts_json`.

use ergotree_ir::mir::value::Value;
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
        // Other variants extended as later arm tasks need them.
        _ => panic!(
            "value_to_json: unsupported variant for current phase-2b arm: {:?}",
            v
        ),
    }
}
