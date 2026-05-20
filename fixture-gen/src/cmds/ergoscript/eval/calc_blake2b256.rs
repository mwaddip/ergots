//! CalcBlake2b256 arm — fixtures for `Expr::CalcBlake2b256(...)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34
//!   let input_v = self.input.eval(env, ctx)?;          // eval-child FIRST
//!   match input_v { Coll[Byte](coll_byte) => {
//!       ctx.add_per_item_jit_cost(20, 7, 128, n)?;     // Pattern B: AFTER eval-child
//!       Ok(blake2b256_hash(coll_byte).to_vec().into())
//!   }, _ => Err(UnexpectedValue(...)) }
//!
//! Build-time type guard: `CalcBlake2b256::try_build` (sigma-rust
//! `ergotree-ir/src/mir/calc_blake2b256.rs:40-47`) calls
//! `input.check_post_eval_tpe(&SType::SColl(SByte))?`, so non-Coll[Byte]
//! inputs cannot be serialized via the standard path. The TS-side
//! `'predef-input-not-byte-array'` assertion is therefore covered by an
//! inline test that calls `evalExpr` directly with a hand-built MIR node
//! (bit_inversion precedent — `packages/ergoscript/test/eval/bit-inversion.test.ts`).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::calc_blake2b256::CalcBlake2b256;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct CalcBlake2b256Fixture {
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
pub struct CalcBlake2b256FixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CalcBlake2b256Fixture>,
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let node = CalcBlake2b256::try_build(input)
        .map_err(|e| anyhow::anyhow!("CalcBlake2b256::try_build: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, input: Expr) -> anyhow::Result<CalcBlake2b256Fixture> {
    let (tree, hex) = build_tree(input)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(CalcBlake2b256Fixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

/// Build a `Vec<i8>` of `len` bytes where item i = (i as i8).
fn ramp_bytes(len: usize) -> Vec<i8> {
    (0..len).map(|i| i as i8).collect()
}

/// Build a `Vec<i8>` of `len` bytes where item i = ((i as i8).wrapping_mul(3)).
fn wrapping_mul3_bytes(len: usize) -> Vec<i8> {
    (0..len).map(|i| (i as i8).wrapping_mul(3)).collect()
}

pub fn generate() -> anyhow::Result<CalcBlake2b256FixtureFile> {
    let mut entries = Vec::new();

    // Coverage:
    //   - empty Coll[Byte] (n=0): exercises chunk-count=0 branch of addPerItemCost.
    //   - 1 byte: 1 chunk.
    //   - 32 bytes: 1 chunk (boundary inside chunk_size=128).
    //   - 64 bytes: 1 chunk.
    //   - 128 bytes: exactly 1 chunk (boundary at chunk_size).
    //   - 1024 bytes: 8 chunks (ceil(1024/128)) — exercises per-chunk accumulation.
    //   - chained CalcBlake2b256(CalcBlake2b256(...)) — verifies the value
    //     produced by the inner call (32-byte digest) is itself a valid input
    //     to the outer call (Coll[Byte] → Coll[Byte]).
    entries.push(success_entry(
        "calc_blake2b256_empty",
        Expr::Const(Vec::<i8>::new().into()),
    )?);
    entries.push(success_entry(
        "calc_blake2b256_1byte",
        Expr::Const(vec![0x42i8].into()),
    )?);
    entries.push(success_entry(
        "calc_blake2b256_32bytes",
        Expr::Const(ramp_bytes(32).into()),
    )?);
    entries.push(success_entry(
        "calc_blake2b256_64bytes",
        Expr::Const(wrapping_mul3_bytes(64).into()),
    )?);
    entries.push(success_entry(
        "calc_blake2b256_128bytes",
        Expr::Const(vec![0xABu8 as i8; 128].into()),
    )?);
    entries.push(success_entry(
        "calc_blake2b256_1024bytes",
        Expr::Const(vec![0x5Au8 as i8; 1024].into()),
    )?);

    // Chained: CalcBlake2b256(CalcBlake2b256([0x01, 0x02, 0x03])) — outer node
    // hashes the 32-byte inner digest. Exercises eval-of-non-Const-child path.
    let inner_const: Expr = Expr::Const(vec![0x01i8, 0x02, 0x03].into());
    let inner_hash: Expr = CalcBlake2b256::try_build(inner_const)
        .map_err(|e| anyhow::anyhow!("inner CalcBlake2b256::try_build: {:?}", e))?
        .into();
    entries.push(success_entry("calc_blake2b256_chain", inner_hash)?);

    Ok(CalcBlake2b256FixtureFile {
        corpus: "eval_calc_blake2b256",
        entries,
    })
}
