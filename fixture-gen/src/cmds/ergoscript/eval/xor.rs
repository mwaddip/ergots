//! Xor arm — pairwise byte XOR via truncating-zip.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/xor.rs:13-41
//!   helper_xor: x.iter().zip(y.iter()) — truncates to shorter operand.
//!     => output length = min(left.len(), right.len())
//!   add_per_item_jit_cost(10, 2, 128, l_byte.len() as u32)
//!     => Pattern B (after eval-child + after type-guard), sized by LEFT length
//!        (NOT min(left, right)).
//!
//! CRITICAL: NO length-mismatch error in sigma-rust — operands of unequal
//! length truncate silently to the shorter via Rust's `Iterator::zip`. The
//! cost-by-LEFT charging makes `xor_left_longer` (n=5) and `xor_right_longer`
//! (n=3) intentionally diverge on `expected_cost` — that asymmetry is the
//! load-bearing signal that the cost is sized by LEFT, not min.
//!
//! Build-time type guard: `Xor::new` (sigma-rust `ergotree-ir/src/mir/xor.rs:27`)
//! validates both operands are `SColl(SByte)` at MIR-construction time, so
//! non-Coll[Byte] inputs cannot be serialized via the standard path. The
//! TS-side `'predef-input-not-byte-array'` assertion is therefore covered by
//! inline tests that call `evalExpr` directly with hand-built MIR nodes
//! (calc_sha256 / bit_inversion precedent).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::mir::xor::Xor;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct XorFixture {
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
pub struct XorFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<XorFixture>,
}

fn build_tree(left: Expr, right: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let node = Xor::new(left, right)
        .map_err(|e| anyhow::anyhow!("Xor::new: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_pair(name: &str, l: Vec<i8>, r: Vec<i8>) -> anyhow::Result<XorFixture> {
    let (tree, hex) = build_tree(Expr::Const(l.into()), Expr::Const(r.into()))?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(XorFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<XorFixtureFile> {
    let mut entries = Vec::new();

    // Coverage:
    //   - both empty: chunk-count=0 branch of addPerItemCost; output empty.
    //   - 32 bytes equal-length: 1 chunk (chunkSize=128); typical case.
    //   - identical inputs: output is all-zero (XOR identity).
    //   - inverse pairs: output is all-FF (-1 in i8); verifies bit-pattern math.
    //   - left longer than right: truncation case; cost sized by LEFT (n=5).
    //   - right longer than left: truncation case; cost sized by LEFT (n=3).
    //     The cost ASYMMETRY between these two is the load-bearing signal that
    //     cost is by LEFT not min — both compute the same 3-byte output.
    //   - 1-byte / single-byte: minimum non-empty.
    //   - 64 bytes (chunkSize boundary at 128 — still 1 chunk).
    //   - 128 bytes (chunkSize boundary — exactly 1 chunk).
    //   - 129 bytes (chunkSize boundary +1 — 2 chunks; exercises ceiling).

    // 1. Both empty.
    entries.push(success_pair("xor_empty", vec![], vec![])?);

    // 2. 32 bytes equal-length.
    entries.push(success_pair(
        "xor_32byte",
        (0..32i8).collect(),
        (0..32i8).map(|i| i.wrapping_mul(7)).collect(),
    )?);

    // 3. Identical -> all-zero.
    entries.push(success_pair(
        "xor_identical_zero",
        vec![0x42; 16],
        vec![0x42; 16],
    )?);

    // 4. Inverse -> all-FF (-1 in i8).
    entries.push(success_pair(
        "xor_inverse_allFF",
        vec![0x42; 16],
        vec![!0x42i8; 16],
    )?);

    // 5. Left longer: cost sized by LEFT (n=5). Output length 3 (min).
    entries.push(success_pair(
        "xor_left_longer",
        vec![1, 2, 3, 4, 5],
        vec![-1, -2, -3],
    )?);

    // 6. Right longer: cost sized by LEFT (n=3). Output length 3 (min).
    //    Same output as xor_left_longer; DIFFERENT expected_cost.
    entries.push(success_pair(
        "xor_right_longer",
        vec![-1, -2, -3],
        vec![1, 2, 3, 4, 5],
    )?);

    // 7. 1-byte each.
    entries.push(success_pair("xor_1byte", vec![0x01], vec![-2])?);

    // 8. Both single distinct.
    entries.push(success_pair("xor_both_single", vec![0x42], vec![0x24])?);

    // 9. 64 bytes (chunk-size=128, ceiling = 1).
    entries.push(success_pair(
        "xor_64byte",
        (0..64i8).map(|i| i.wrapping_mul(3)).collect(),
        (0..64i8).rev().collect(),
    )?);

    // 10. 128 bytes (exactly 1 chunk).
    entries.push(success_pair(
        "xor_128byte",
        (0..128i32).map(|i| (i as i8).wrapping_mul(5)).collect(),
        (0..128i32).map(|i| !(i as i8)).collect(),
    )?);

    // 11. 129 bytes (2 chunks — exercises ceiling).
    entries.push(success_pair(
        "xor_129byte",
        (0..129i32).map(|i| (i as i8).wrapping_mul(11)).collect(),
        (0..129i32).map(|i| (i as i8) ^ 0x55).collect(),
    )?);

    // 12. left=200 bytes, right=10 bytes. Cost charged by LEFT (200 → 2 chunks).
    //     If cost were charged by min(left,right)=10, this would be 1 chunk.
    //     Pair with #13 (mirror image) to make the asymmetry observable.
    entries.push(success_pair(
        "xor_left_long_right_short",
        (0..200i32).map(|i| (i as i8).wrapping_mul(13)).collect(),
        (0..10i8).collect(),
    )?);

    // 13. left=10 bytes, right=200 bytes. Cost charged by LEFT (10 → 1 chunk).
    //     Same output bytes as #12; DIFFERENT expected_cost (LEFT-vs-min asymmetry).
    entries.push(success_pair(
        "xor_left_short_right_long",
        (0..10i8).collect(),
        (0..200i32).map(|i| (i as i8).wrapping_mul(13)).collect(),
    )?);

    Ok(XorFixtureFile {
        corpus: "eval_xor",
        entries,
    })
}
