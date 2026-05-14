//! Shared types for phase 2b eval fixtures.
//!
//! Each per-arm command emits a `EvalFixtureFile` containing a `Vec<EvalFixture>`.
//! Sigma-rust is the oracle: each fixture's `expected_value_json` and
//! `expected_cost` come from running `expr.eval(env, ctx)` against a
//! synthetic Context built from `opts_json`.

use ergotree_ir::mir::value::Value;
use serde::Serialize;
use serde_json::Value as JsonValue;

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
/// Use this in each arm's fixture command.
pub fn value_to_json(v: &Value) -> JsonValue {
    // Stub for task 7. Actual encoding logic added incrementally as each
    // arm's fixture command requires more SValue variants. Most early
    // arms only need Boolean / Byte / Short / Int / Long / BigInt /
    // Coll / Tuple. Box / SigmaProp / GroupElement are deferred to 2g+.
    serde_json::to_value(format!("{:?}", v)).unwrap()
}
