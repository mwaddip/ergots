//! ByteArrayToBigInt arm — fixtures for `Expr::ByteArrayToBigInt(...)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34
//!   ctx.add_jit_cost(30)?;                              // Pattern A: BEFORE eval-child
//!   let input = self.input.eval(env, ctx)?.try_extract_into::<Vec<u8>>()?;
//!   if input.is_empty() { return Err(UnexpectedValue("ByteArrayToBigInt: byte array is empty")); }
//!   match BigInt256::from_be_slice(&input[..]) {
//!       Some(n) => Ok(Value::BigInt(n)),
//!       None    => Err(UnexpectedValue("ByteArrayToBigInt: input array out of bounds")),
//!   }
//!
//! `BigInt256::from_be_slice` (bigint256.rs:55-62) rejects empty and delegates to
//! `bnum::I256::from_be_slice` which returns `None` for slices whose value falls
//! outside `[I256::MIN, I256::MAX]` = `[-2^255, 2^255 - 1]`. The slice length is
//! NOT capped at 32: sigma-rust's `eval_above_max_bound`/`eval_below_min_bound`
//! tests confirm 33-byte inputs are accepted when their value fits, rejected
//! when it doesn't.
//!
//! Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(30).
//!
//! Build-time type guard: `ByteArrayToBigInt::try_build` (sigma-rust
//! `ergotree-ir/src/mir/byte_array_to_bigint.rs:43-49`) calls
//! `input.check_post_eval_tpe(&SType::SColl(SByte))?`, so non-Coll[Byte]
//! inputs cannot be serialized via the standard path. The TS-side
//! `'predef-input-not-byte-array'` assertion is covered by an inline TS test
//! that calls `evalExpr` directly with a hand-built MIR node
//! (byte_array_to_long precedent).

use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::byte_array_to_bigint::ByteArrayToBigInt;
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
pub struct ByteArrayToBigIntFixture {
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
pub struct ByteArrayToBigIntFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ByteArrayToBigIntFixture>,
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let node = ByteArrayToBigInt::try_build(input)
        .map_err(|e| anyhow::anyhow!("ByteArrayToBigInt::try_build: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, bytes: Vec<i8>) -> anyhow::Result<ByteArrayToBigIntFixture> {
    let (tree, hex) = build_tree(Expr::Const(bytes.into()))?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ByteArrayToBigIntFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn error_entry(name: &str, bytes: Vec<i8>, code: &str) -> anyhow::Result<ByteArrayToBigIntFixture> {
    // For error entries we still build & serialize the tree (so the TS parser
    // can decode it the same way), but we don't run sigma-rust eval against it;
    // the TS test asserts only the expected error code (per existing fixture convention).
    let (_tree, hex) = build_tree(Expr::Const(bytes.into()))?;
    Ok(ByteArrayToBigIntFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<ByteArrayToBigIntFixtureFile> {
    let mut entries = Vec::new();

    // Coverage (10 scenarios — i256-boundary-heavy per sigma-rust test corpus
    // at byte_array_to_bigint.rs:54-138):
    //
    //   Happy paths (8):
    //     - b2bi_plus_one          : +1 (single byte 0x01).
    //     - b2bi_neg_one_1byte     : -1 (single byte 0xFF — high-bit sign).
    //     - b2bi_neg_one_2byte     : -1 (0xFFFF — verifies sign-extension across multi-byte slices).
    //     - b2bi_256               : +256 (0x0100 — multi-byte positive).
    //     - b2bi_neg_32768         : -32768 (0x8000 — i16::MIN, high-bit set on first byte).
    //     - b2bi_i256_max          : i256::MAX = 2^255 - 1 (32 bytes: 0x7F + 31×0xFF).
    //     - b2bi_i256_min          : i256::MIN = -2^255 (32 bytes: 0x80 + 31×0x00).
    //     - b2bi_33byte_in_range   : 33 bytes leading 0x00 sign-extension, value `0x7E << 248`
    //                                (in range, exercises >32-byte path).
    //
    //   Error paths (2):
    //     - b2bi_33byte_above_max  : 33 bytes [0x00, 0x80, 0×31] — value = 2^255 = i256::MAX + 1
    //                                (mirrors sigma-rust `eval_above_max_bound` at lines 107-118).
    //     - b2bi_empty             : length-0 input — `BigInt256::from_be_slice` returns None,
    //                                short-circuited by the explicit `is_empty()` check at
    //                                byte_array_to_bigint.rs:20-22 (mirrors `eval_empty` at line 134-138).
    entries.push(success_entry("b2bi_plus_one", vec![0x01])?);
    entries.push(success_entry("b2bi_neg_one_1byte", vec![-1i8])?);
    entries.push(success_entry("b2bi_neg_one_2byte", vec![-1i8, -1])?);
    entries.push(success_entry("b2bi_256", vec![1, 0])?);
    entries.push(success_entry("b2bi_neg_32768", vec![-128, 0])?);

    let mut max_buf = vec![-1i8; 32];
    max_buf[0] = 0x7F;
    entries.push(success_entry("b2bi_i256_max", max_buf)?);

    let mut min_buf = vec![0i8; 32];
    min_buf[0] = -128; // 0x80
    entries.push(success_entry("b2bi_i256_min", min_buf)?);

    let mut in_range_33 = vec![0i8; 33];
    in_range_33[1] = 0x7E;
    entries.push(success_entry("b2bi_33byte_in_range", in_range_33)?);

    let mut above_max = vec![0i8; 33];
    above_max[1] = -128; // 0x80 → value just above i256::MAX
    entries.push(error_entry(
        "b2bi_33byte_above_max",
        above_max,
        "byte-array-to-bigint-out-of-range",
    )?);

    entries.push(error_entry(
        "b2bi_empty",
        vec![],
        "byte-array-to-bigint-empty",
    )?);

    Ok(ByteArrayToBigIntFixtureFile {
        corpus: "eval_byte_array_to_bigint",
        entries,
    })
}
