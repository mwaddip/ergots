//! Upcast arm — fixtures for `Expr::Upcast(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/upcast.rs:78-92`
//!   let input_v = self.input.eval(env, ctx)?;            // eval child FIRST
//!   ctx.add_jit_cost(if self.tpe == SType::SBigInt { 30 } else { 10 })?;
//!   match self.tpe {
//!       SType::SBigInt => upcast_to_bigint(input_v, ctx),
//!       SType::SLong   => upcast_to_long(input_v),
//!       SType::SInt    => upcast_to_int(input_v),
//!       SType::SShort  => upcast_to_short(input_v),
//!       SType::SByte   => upcast_to_byte(input_v),
//!       _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! Cost ordering: envelope charged AFTER eval-child (sigma-rust line 78 →
//! 80). DIFFERENT from Negation / BitInversion / LogicalNot which charge
//! before. Captured per-fixture by `expected_cost`.
//!
//! Cost values: `TypeBased(bigint=30, other=10)` — 30 if target is
//! SBigInt, 10 for any other numeric target. Inline literal in sigma-rust
//! (not in `costs.rs`). The fixture-gen's `ctx.jit_cost_value()` after
//! eval captures the per-entry cost so the TS side can assert each.
//!
//! Same-kind Upcast resolution (source-read at
//! `ergotree-interpreter/src/eval/upcast.rs:31, 43, 54, 64`):
//!   - Byte → Byte, Short → Short, Int → Int, Long → Long: PERMITTED as
//!     no-op, at any tree version. Represented here by `upcast_int_int_noop`.
//!   - BigInt → BigInt: only permitted when `ctx.tree_version() >= V3`
//!     (`upcast.rs:18`). Our fixture trees use `ErgoTreeHeader::v0(false)`,
//!     so V0 < V3, and `Upcast(BigInt → BigInt)` REJECTED at eval-time with
//!     `EvalError::UnexpectedValue`. Skipped here (would not produce a
//!     successful sigma-rust oracle entry at V0).
//!
//! `Upcast::new` strictness (`ergotree-ir/src/mir/upcast.rs:29-48`):
//!   - Target type must be numeric (line 30).
//!   - Input's post-eval type must be numeric (line 37).
//!   - Does NOT enforce target ≥ source width (e.g. `Upcast(Long → Int)`
//!     builds successfully and fails at eval). We never generate narrowing
//!     Upcast fixtures here; that's Downcast's territory in Task 5.
//!
//! Non-numeric source error case is NOT generated here. `Upcast::new`
//! rejects non-numeric input at build time, so we cannot serialize a
//! malformed tree through the standard path. The TS-side
//! `'bin-op-not-numeric'` assertion is covered by an inline test that
//! calls `evalExpr` directly with a hand-built MIR node (BitInversion /
//! Negation precedent).
//!
//! Coverage:
//!   - 10 widening pairs × 2 boundary values (0, MAX of source kind) = 20
//!     happy entries.
//!   - 1 same-kind no-op entry (Int → Int).
//!   - Total: 21 entries.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::upcast::Upcast;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct UpcastFixture {
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
pub struct UpcastFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<UpcastFixture>,
}

fn build_tree(input: Expr, target: SType) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = Upcast::new(input, target)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(
    name: &str,
    input: Expr,
    target: SType,
) -> anyhow::Result<UpcastFixture> {
    let (tree, hex) = build_tree(input, target)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(UpcastFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<UpcastFixtureFile> {
    let mut entries = Vec::new();

    // =========================================================================
    // Widening: Byte → {Short, Int, Long, BigInt}
    // =========================================================================
    entries.push(success_entry(
        "upcast_byte_to_short_zero",
        Expr::Const(0i8.into()),
        SType::SShort,
    )?);
    entries.push(success_entry(
        "upcast_byte_to_short_max",
        Expr::Const(i8::MAX.into()),
        SType::SShort,
    )?);
    entries.push(success_entry(
        "upcast_byte_to_int_zero",
        Expr::Const(0i8.into()),
        SType::SInt,
    )?);
    entries.push(success_entry(
        "upcast_byte_to_int_max",
        Expr::Const(i8::MAX.into()),
        SType::SInt,
    )?);
    entries.push(success_entry(
        "upcast_byte_to_long_zero",
        Expr::Const(0i8.into()),
        SType::SLong,
    )?);
    entries.push(success_entry(
        "upcast_byte_to_long_max",
        Expr::Const(i8::MAX.into()),
        SType::SLong,
    )?);
    entries.push(success_entry(
        "upcast_byte_to_bigint_zero",
        Expr::Const(0i8.into()),
        SType::SBigInt,
    )?);
    entries.push(success_entry(
        "upcast_byte_to_bigint_max",
        Expr::Const(i8::MAX.into()),
        SType::SBigInt,
    )?);

    // =========================================================================
    // Widening: Short → {Int, Long, BigInt}
    // =========================================================================
    entries.push(success_entry(
        "upcast_short_to_int_zero",
        Expr::Const(0i16.into()),
        SType::SInt,
    )?);
    entries.push(success_entry(
        "upcast_short_to_int_max",
        Expr::Const(i16::MAX.into()),
        SType::SInt,
    )?);
    entries.push(success_entry(
        "upcast_short_to_long_zero",
        Expr::Const(0i16.into()),
        SType::SLong,
    )?);
    entries.push(success_entry(
        "upcast_short_to_long_max",
        Expr::Const(i16::MAX.into()),
        SType::SLong,
    )?);
    entries.push(success_entry(
        "upcast_short_to_bigint_zero",
        Expr::Const(0i16.into()),
        SType::SBigInt,
    )?);
    entries.push(success_entry(
        "upcast_short_to_bigint_max",
        Expr::Const(i16::MAX.into()),
        SType::SBigInt,
    )?);

    // =========================================================================
    // Widening: Int → {Long, BigInt}
    // =========================================================================
    entries.push(success_entry(
        "upcast_int_to_long_zero",
        Expr::Const(0i32.into()),
        SType::SLong,
    )?);
    entries.push(success_entry(
        "upcast_int_to_long_max",
        Expr::Const(i32::MAX.into()),
        SType::SLong,
    )?);
    entries.push(success_entry(
        "upcast_int_to_bigint_zero",
        Expr::Const(0i32.into()),
        SType::SBigInt,
    )?);
    entries.push(success_entry(
        "upcast_int_to_bigint_max",
        Expr::Const(i32::MAX.into()),
        SType::SBigInt,
    )?);

    // =========================================================================
    // Widening: Long → BigInt
    // =========================================================================
    entries.push(success_entry(
        "upcast_long_to_bigint_zero",
        Expr::Const(0i64.into()),
        SType::SBigInt,
    )?);
    entries.push(success_entry(
        "upcast_long_to_bigint_max",
        Expr::Const(i64::MAX.into()),
        SType::SBigInt,
    )?);

    // =========================================================================
    // Same-kind no-op (Int → Int, representative of Byte/Short/Int/Long
    // same-kind no-op behavior — sigma-rust upcast.rs:43). BigInt → BigInt
    // skipped (requires tree_version ≥ V3; our V0 trees would reject).
    // =========================================================================
    entries.push(success_entry(
        "upcast_int_to_int_noop",
        Expr::Const(0i32.into()),
        SType::SInt,
    )?);

    Ok(UpcastFixtureFile {
        corpus: "eval_upcast",
        entries,
    })
}
