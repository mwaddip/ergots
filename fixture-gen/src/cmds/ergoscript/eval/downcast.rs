//! Downcast arm — fixtures for `Expr::Downcast(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/downcast.rs:111-132`
//!   let input_v = self.input.eval(env, ctx)?;             // eval child FIRST
//!   ctx.add_jit_cost(if self.tpe == SType::SBigInt { 30 } else { 10 })?;
//!   match self.tpe {
//!       SType::SBigInt => downcast_to_bigint(input_v, ctx),
//!       SType::SLong   => downcast_to_long(input_v, ctx),
//!       SType::SInt    => downcast_to_int(input_v, ctx),
//!       SType::SShort  => downcast_to_short(input_v, ctx),
//!       SType::SByte   => downcast_to_byte(input_v, ctx),
//!       _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! Cost ordering: envelope charged AFTER eval-child (sigma-rust line 117 →
//! 119). Same pattern as Upcast (also Cast-arm family). DIFFERENT from
//! Negation / BitInversion / LogicalNot which charge before. Captured
//! per-fixture by `expected_cost`.
//!
//! Cost values: `TypeBased(bigint=30, other=10)` — 30 if target is SBigInt,
//! 10 for any other numeric target. Inline literal in sigma-rust
//! (not in `costs.rs`).
//!
//! Out-of-range narrowing: each `downcast_to_*` invokes `wrap_downcast` on
//! the underlying primitive `to_iN()` conversion (`downcast.rs:15-22`).
//! `wrap_downcast` returns `EvalError::UnexpectedValue("Downcast: overflow
//! converting to ...")` when the value lies outside the target's signed
//! range. The TS side surfaces this as the new `'downcast-overflow'`
//! EvalError code (distinct from `'arith-overflow'` so callers can dispatch
//! on "downcast specifically failed").
//!
//! Note (lesson from this slice): sigma-rust's `add_jit_cost` is charged
//! AFTER eval-child but BEFORE the per-target downcast computation. Cost is
//! therefore charged even on overflow paths. `ctx.jit_cost_value()` after a
//! failed `try_eval_out` still reflects the cost at the point of failure,
//! so error fixtures still have meaningful (non-zero) cost — but our
//! schema sets `expected_cost = 0` for error entries (the TS test only
//! checks `code` on errors, not cost). Source: `downcast.rs:117-119`.
//!
//! Same-kind Downcast resolution (source-read at
//! `ergotree-interpreter/src/eval/downcast.rs:30, 44, 60, 75, 96`):
//!   - Byte → Byte, Short → Short, Int → Int, Long → Long: PERMITTED as
//!     no-op, at any tree version. Represented here by `downcast_int_int_noop`.
//!   - BigInt → BigInt: only permitted when `ctx.tree_version() >= V3`
//!     (`downcast.rs:30`). Our fixture trees use `ErgoTreeHeader::v0(false)`,
//!     so V0 < V3, and `Downcast(BigInt → BigInt)` REJECTED at eval-time
//!     with `EvalError::UnexpectedValue`. Skipped here (would not produce a
//!     successful sigma-rust oracle entry at V0). Same constraint as Upcast.
//!
//! BigInt → primitive narrowing (BigInt → Long/Int/Short/Byte): ALL these
//! pairs require `ctx.tree_version() >= V3` per `downcast.rs:45, 62, 83,
//! 100`. At V0/V1/V2, sigma-rust hits the `_ => Err(...)` fallthrough arms
//! (lines 49, 66, 87, 104) which return "cannot downcast" — a version-gating
//! rejection. Phase 2e adds explicit error entries for V0/V1/V2 with code
//! 'tree-version-too-low'. Happy-path BigInt → primitive entries use V3.
//!
//! V3 gating (phase 2e task 1): source=BigInt requires tree_version >= V3
//! regardless of target kind. Every `downcast_to_*` function in sigma-rust
//! gates `Value::BigInt(v) if ctx.tree_version() >= V3`.
//!
//! `Downcast::new` strictness (`ergotree-ir/src/mir/downcast.rs:29-48`):
//!   - Target type must be numeric (line 30).
//!   - Input's post-eval type must be numeric (line 37).
//!   - Does NOT enforce target ≤ source width (e.g. `Downcast(Byte → Long)`
//!     would build successfully — though it's nonsensical; the eval result
//!     would still match the wider value through the `Value::Byte(v) => Ok((v
//!     as i64).into())` upcast-like arm). We don't generate such fixtures.
//!
//! Non-numeric source error case is NOT generated here. `Downcast::new`
//! rejects non-numeric input at build time, so we cannot serialize a
//! malformed tree through the standard path. The TS-side
//! `'bin-op-not-numeric'` assertion is covered by an inline test that
//! calls `evalExpr` directly with a hand-built MIR node (Upcast precedent).
//!
//! Coverage:
//!   - Long → {Int, Short, Byte} = 3 pairs × (happy + overflow) = 6 entries
//!   - Int → {Short, Byte} = 2 pairs × (happy + overflow) = 4 entries
//!   - Short → Byte = 1 pair × (happy + overflow) = 2 entries
//!   - 1 same-kind no-op entry (Int → Int).
//!   - 4 V0/V1/V2 BigInt error entries ('tree-version-too-low').
//!   - Total: 17 entries.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::downcast::Downcast;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct DowncastFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for error entries
    pub expected_value_json: JsonValue,
    /// 0 for error entries (TS test only checks code on errors, not cost)
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct DowncastFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<DowncastFixture>,
}

fn build_tree(input: Expr, target: SType) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = Downcast::new(input, target)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(
    name: &str,
    input: Expr,
    target: SType,
) -> anyhow::Result<DowncastFixture> {
    let (tree, hex) = build_tree(input, target)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(DowncastFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn overflow_entry(
    name: &str,
    input: Expr,
    target: SType,
) -> anyhow::Result<DowncastFixture> {
    // Build a Downcast tree whose input is known to be outside the target's
    // signed range. Confirm sigma-rust rejects at eval (oracle), then emit
    // an error fixture with code 'downcast-overflow'.
    let (tree, hex) = build_tree(input, target)?;
    let ctx = force_any_val::<Context>();
    let result: Result<Value<'static>, _> = try_eval_out(&tree.proposition()?, &ctx);
    if result.is_ok() {
        anyhow::bail!(
            "overflow_entry {}: sigma-rust accepted value as in-range — \
             fixture intent is wrong",
            name
        );
    }
    Ok(DowncastFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("downcast-overflow"),
    })
}

/// Error entry: builds a BigInt-source Downcast tree and emits a fixture
/// asserting 'tree-version-too-low' at the given version (<V3).
///
/// We do NOT run sigma-rust eval here because Rust's error text differs
/// from our TS code and we don't need the oracle value — the TS assertion
/// is on the error code only.
///
/// Sigma-rust ref: every `downcast_to_*` function gates
/// `Value::BigInt(v) if ctx.tree_version() >= ErgoTreeVersion::V3`.
fn tree_version_error_entry(
    name: &str,
    input: Expr,
    target: SType,
    tree_version: u8,
) -> anyhow::Result<DowncastFixture> {
    let (_, hex) = build_tree(input, target)?;
    Ok(DowncastFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "treeVersion": tree_version }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("tree-version-too-low"),
    })
}


pub fn generate() -> anyhow::Result<DowncastFixtureFile> {
    let mut entries = Vec::new();

    // =========================================================================
    // Narrowing: Long → {Int, Short, Byte}
    // =========================================================================
    // Long → Int: happy (zero) + overflow (i32::MAX + 1 as i64)
    entries.push(success_entry(
        "downcast_long_to_int_zero",
        Expr::Const(0i64.into()),
        SType::SInt,
    )?);
    entries.push(overflow_entry(
        "downcast_long_to_int_overflow_pos",
        Expr::Const((i32::MAX as i64 + 1).into()),
        SType::SInt,
    )?);

    // Long → Short: happy (zero) + overflow
    entries.push(success_entry(
        "downcast_long_to_short_zero",
        Expr::Const(0i64.into()),
        SType::SShort,
    )?);
    entries.push(overflow_entry(
        "downcast_long_to_short_overflow_pos",
        Expr::Const((i16::MAX as i64 + 1).into()),
        SType::SShort,
    )?);

    // Long → Byte: happy (zero) + overflow
    entries.push(success_entry(
        "downcast_long_to_byte_zero",
        Expr::Const(0i64.into()),
        SType::SByte,
    )?);
    entries.push(overflow_entry(
        "downcast_long_to_byte_overflow_pos",
        Expr::Const((i8::MAX as i64 + 1).into()),
        SType::SByte,
    )?);

    // =========================================================================
    // Narrowing: Int → {Short, Byte}
    // =========================================================================
    // Int → Short: happy (zero) + overflow
    entries.push(success_entry(
        "downcast_int_to_short_zero",
        Expr::Const(0i32.into()),
        SType::SShort,
    )?);
    entries.push(overflow_entry(
        "downcast_int_to_short_overflow_pos",
        Expr::Const((i16::MAX as i32 + 1).into()),
        SType::SShort,
    )?);

    // Int → Byte: happy (zero) + overflow
    entries.push(success_entry(
        "downcast_int_to_byte_zero",
        Expr::Const(0i32.into()),
        SType::SByte,
    )?);
    entries.push(overflow_entry(
        "downcast_int_to_byte_overflow_pos",
        Expr::Const((i8::MAX as i32 + 1).into()),
        SType::SByte,
    )?);

    // =========================================================================
    // Narrowing: Short → Byte
    // =========================================================================
    entries.push(success_entry(
        "downcast_short_to_byte_zero",
        Expr::Const(0i16.into()),
        SType::SByte,
    )?);
    entries.push(overflow_entry(
        "downcast_short_to_byte_overflow_pos",
        Expr::Const((i8::MAX as i16 + 1).into()),
        SType::SByte,
    )?);

    // =========================================================================
    // Same-kind no-op (Int → Int, representative of Byte/Short/Int/Long
    // same-kind no-op behavior — sigma-rust downcast.rs:60).
    // =========================================================================
    entries.push(success_entry(
        "downcast_int_to_int_noop",
        Expr::Const(0i32.into()),
        SType::SInt,
    )?);

    // =========================================================================
    // BigInt source V3 gating (phase 2e task 1).
    // source=BigInt requires tree_version >= V3 regardless of target kind.
    // sigma-rust ref: every downcast_to_* function gates Value::BigInt on V3+.
    // =========================================================================
    entries.push(tree_version_error_entry(
        "downcast_bigint_to_long_v0_gated",
        Expr::Const(BigInt256::from(0i64).into()),
        SType::SLong,
        0,
    )?);
    entries.push(tree_version_error_entry(
        "downcast_bigint_to_int_v1_gated",
        Expr::Const(BigInt256::from(0i64).into()),
        SType::SInt,
        1,
    )?);
    entries.push(tree_version_error_entry(
        "downcast_bigint_to_short_v2_gated",
        Expr::Const(BigInt256::from(0i64).into()),
        SType::SShort,
        2,
    )?);
    entries.push(tree_version_error_entry(
        "downcast_bigint_to_byte_v2_gated",
        Expr::Const(BigInt256::from(0i64).into()),
        SType::SByte,
        2,
    )?);

    Ok(DowncastFixtureFile {
        corpus: "eval_downcast",
        entries,
    })
}
