//! LongToByteArray arm — fixtures for `Expr::LongToByteArray(...)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/long_to_byte_array.rs:11-25
//!   ctx.add_jit_cost(17)?;                            // Pattern A: BEFORE eval-child
//!   let mut val = self.input.eval(env, ctx)?.try_extract_into::<i64>()?;
//!   // pack to 8 bytes big-endian
//!   Ok(buf.into())  // Coll[Byte] of length 8
//!
//! Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(17).
//! Inverse of ByteArrayToLong (T4).
//!
//! Build-time type guard: `LongToByteArray::try_build` (sigma-rust
//! `ergotree-ir/src/mir/long_to_byte_array.rs:43-48`) calls
//! `input.check_post_eval_tpe(&SType::SLong)?`, so non-SLong inputs cannot be
//! serialized via the standard path. The TS-side `'predef-input-not-long'`
//! assertion is therefore covered by an inline test that calls `evalExpr`
//! directly with a hand-built MIR node (calc_blake2b256 / byte_array_to_long
//! precedent).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::long_to_byte_array::LongToByteArray;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct LongToByteArrayFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for error entries (none for this arm — all build-rejected before serialize)
    pub expected_value_json: JsonValue,
    /// 0 for error entries
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct LongToByteArrayFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<LongToByteArrayFixture>,
}

fn build_tree(value: i64) -> anyhow::Result<(ErgoTree, String)> {
    let node = LongToByteArray::try_build(Expr::Const(value.into()))
        .map_err(|e| anyhow::anyhow!("LongToByteArray::try_build: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, value: i64) -> anyhow::Result<LongToByteArrayFixture> {
    let (tree, hex) = build_tree(value)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(LongToByteArrayFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<LongToByteArrayFixtureFile> {
    let mut entries = Vec::new();

    // Coverage (7 happy-path scenarios; throw-path covered by inline TS test
    // because sigma-rust's `LongToByteArray::try_build` rejects non-SLong
    // inputs at build time):
    //   - l2b_plus_one             : +1                — `00 00 00 00 00 00 00 01`
    //   - l2b_neg_one              : -1                — all 0xFF (sign-bit-set)
    //   - l2b_zero                 : 0                 — all zero bytes
    //   - l2b_max                  : i64::MAX          — `7F FF FF FF FF FF FF FF`
    //   - l2b_min                  : i64::MIN          — `80 00 00 00 00 00 00 00`
    //   - l2b_high_bit_plus_one    : i64::MIN + 1      — `80 00 00 00 00 00 00 01`
    //   - l2b_roundtrip_candidate  : 0x12345678        — small positive non-extreme.
    entries.push(success_entry("l2b_plus_one", 1i64)?);
    entries.push(success_entry("l2b_neg_one", -1i64)?);
    entries.push(success_entry("l2b_zero", 0i64)?);
    entries.push(success_entry("l2b_max", i64::MAX)?);
    entries.push(success_entry("l2b_min", i64::MIN)?);
    entries.push(success_entry("l2b_high_bit_plus_one", i64::MIN + 1)?);
    entries.push(success_entry("l2b_roundtrip_candidate", 0x12345678i64)?);

    Ok(LongToByteArrayFixtureFile {
        corpus: "eval_long_to_byte_array",
        entries,
    })
}
