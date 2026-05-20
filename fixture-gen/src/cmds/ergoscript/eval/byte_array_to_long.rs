//! ByteArrayToLong arm — fixtures for `Expr::ByteArrayToLong(...)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_long.rs:18-34
//!   ctx.add_jit_cost(16)?;                              // Pattern A: BEFORE eval-child
//!   let input = self.input.eval(env, ctx)?.try_extract_into::<Vec<u8>>()?;
//!   if input.len() < 8 { return Err(UnexpectedValue("byteArrayToLong: array must contain at least 8 elements")); }
//!   Ok((((input[0] as i64) << 56) | ... | (input[7] as i64)).into())
//!
//! `eval_skip_tail` test at byte_array_to_long.rs:62-65 confirms trailing
//! bytes after the first 8 are IGNORED (NOT a length-equality check).
//!
//! Build-time type guard: `ByteArrayToLong::try_build` (sigma-rust
//! `ergotree-ir/src/mir/byte_array_to_long.rs:41-47`) calls
//! `input.check_post_eval_tpe(&SType::SColl(SByte))?`, so non-Coll[Byte]
//! inputs cannot be serialized via the standard path. The TS-side
//! `'predef-input-not-byte-array'` assertion is therefore covered by an
//! inline test that calls `evalExpr` directly with a hand-built MIR node
//! (calc_blake2b256 precedent).

use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::byte_array_to_long::ByteArrayToLong;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ByteArrayToLongFixture {
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
pub struct ByteArrayToLongFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ByteArrayToLongFixture>,
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let node = ByteArrayToLong::try_build(input)
        .map_err(|e| anyhow::anyhow!("ByteArrayToLong::try_build: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, bytes: Vec<i8>) -> anyhow::Result<ByteArrayToLongFixture> {
    let (tree, hex) = build_tree(Expr::Const(bytes.into()))?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ByteArrayToLongFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn error_entry(name: &str, bytes: Vec<i8>, code: &str) -> anyhow::Result<ByteArrayToLongFixture> {
    // For error entries we still build & serialize the tree (so the TS parser
    // can decode it the same way), but we don't run sigma-rust eval against it;
    // the TS test asserts only the expected error code (per existing fixture convention).
    let (_tree, hex) = build_tree(Expr::Const(bytes.into()))?;
    Ok(ByteArrayToLongFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<ByteArrayToLongFixtureFile> {
    let mut entries = Vec::new();

    // Coverage:
    //   Happy paths (9):
    //     - b2l_plus_one          : +1 (8 zero bytes + 0x01).
    //     - b2l_neg_one           : -1 (all 0xFF bytes — high-bit-set sign extension).
    //     - b2l_zero              : 0 (all zero bytes).
    //     - b2l_max               : i64::MAX = 0x7FFFFFFFFFFFFFFF.
    //     - b2l_min               : i64::MIN = 0x8000000000000000.
    //     - b2l_high_bit          : high-bit-set non-extreme value.
    //     - b2l_length_9_skip_tail: length-9 input — trailing byte ignored.
    //     - b2l_length_16_skip_tail: length-16 — trailing 8 bytes ignored.
    //     - b2l_sigmastate_equiv_1: scala sigmastate-interpreter equivalence vector
    //                               (from sigma-rust byte_array_to_long.rs::test_equivalence).
    //   Error paths (2):
    //     - b2l_empty             : length-0 input — fails length check.
    //     - b2l_length_7          : length-7 input — boundary just below 8.
    entries.push(success_entry("b2l_plus_one", vec![0, 0, 0, 0, 0, 0, 0, 1])?);
    entries.push(success_entry("b2l_neg_one", vec![-1; 8])?);
    entries.push(success_entry("b2l_zero", vec![0; 8])?);
    entries.push(success_entry(
        "b2l_max",
        vec![0x7F, -1, -1, -1, -1, -1, -1, -1],
    )?);
    entries.push(success_entry(
        "b2l_min",
        vec![-128, 0, 0, 0, 0, 0, 0, 0],
    )?);
    entries.push(success_entry(
        "b2l_high_bit",
        vec![-128, 0, 0, 0, 0, 0, 0, 1],
    )?);
    entries.push(success_entry(
        "b2l_length_9_skip_tail",
        vec![0, 0, 0, 0, 0, 0, 0, 1, 0x42],
    )?);
    entries.push(success_entry(
        "b2l_length_16_skip_tail",
        vec![0, 0, 0, 0, 0, 0, 0, 1, -1, -1, -1, -1, -1, -1, -1, -1],
    )?);
    entries.push(success_entry(
        "b2l_sigmastate_equiv_1",
        hex::decode("712d7f00ff807f7f")
            .unwrap()
            .into_iter()
            .map(|b| b as i8)
            .collect(),
    )?);
    entries.push(error_entry(
        "b2l_empty",
        vec![],
        "byte-array-to-long-too-short",
    )?);
    entries.push(error_entry(
        "b2l_length_7",
        vec![0; 7],
        "byte-array-to-long-too-short",
    )?);

    Ok(ByteArrayToLongFixtureFile {
        corpus: "eval_byte_array_to_long",
        entries,
    })
}
