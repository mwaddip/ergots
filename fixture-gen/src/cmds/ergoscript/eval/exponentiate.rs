//! Exponentiate arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/exponentiate.rs:13-33
//!   ctx.add_jit_cost(900)?;
//!   let left_v = self.left.eval(env, ctx)?.try_extract_into()?;
//!   let right_v = self.right.eval(env, ctx)?.try_extract_into()?;
//!   exponentiate(left_v, right_v)
//!
//! Then ec_point::exponentiate at ec_point.rs:111-119:
//!   if !is_identity(base) { EcPoint(base.0 * exponent) } else { *base }
//!
//! Sigma-rust dlog_group::bigint256_to_scalar (dlog_group.rs:60-64):
//!   UnsignedBigInt::from_signed_mod(bi, order()).unwrap().into()
//! — modular reduction with positive lift; for negative BigInt256, adds n
//!   to lift into [0, n).
//!
//! Pattern A — cost BEFORE eval-children. Fixed(900) regardless of exponent
//! magnitude.
//!
//! Build-time type guard: `Exponentiate::new` (sigma-rust
//! `ergotree-ir/src/mir/exponentiate.rs:25-39`) enforces
//! `(SGroupElement, SBigInt)` operands at construction, so non-GroupElement /
//! non-BigInt inputs cannot be serialized via the standard path. The TS-side
//! `'group-op-input-not-group-element'` / `'predef-input-not-bigint'`
//! assertions are defensive against `ConstantPlaceholder` injection or
//! hand-crafted MIR (multiply_group throw-entry precedent).
//!
//! Scenarios (9 success + 2 throw = 11):
//!   - exp_gen_1            : g^1   = g
//!   - exp_gen_0            : g^0   = identity (mod-n reduces to 0 → identity short-circuit in pointMul)
//!   - exp_gen_random       : g^k where k is a deterministic mid-range 32-byte value
//!   - exp_identity_k       : identity^k = identity (★ validates the explicit TS identity-base guard)
//!   - exp_gen_minus_1      : g^-1  → mod-n reduces to g^(n-1) = -g (curve inverse)
//!   - exp_gen_n_minus_1    : g^(n-1) via 32-byte BE of (n-1) interpreted as signed i256 → mod-n
//!   - exp_gen_n            : g^n   via 32-byte BE of n interpreted as signed i256 → mod-n
//!   - exp_gen_i256_max     : g^(2^255 - 1) — largest positive i256
//!   - exp_gen_i256_min     : g^(-2^255)    — most negative i256
//!   - exp_throw_non_grp_base   : Const(SInt, 42) base → 'group-op-input-not-group-element'
//!   - exp_throw_non_bigint_exp : Const(SInt, 42) exponent → 'predef-input-not-bigint'

use ergo_chain_types::ec_point::{generator, identity};
use ergo_chain_types::EcPoint;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::bigint256::BigInt256;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::exponentiate::Exponentiate;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use num_traits::Num;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ExponentiateFixture {
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
pub struct ExponentiateFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<ExponentiateFixture>,
}

/// Build a Const(SGroupElement, ec) expression.
fn const_group(ec: EcPoint) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = ec.into();
    c.into()
}

/// Build a Const(SBigInt, n) expression.
fn const_bigint(n: BigInt256) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = n.into();
    c.into()
}

/// Build a Const(SInt, n) expression — synthesized non-(SGroupElement, SBigInt)
/// input that drives the build-time-bypass throw paths.
fn const_int(n: i32) -> Expr {
    let c: ergotree_ir::mir::constant::Constant = n.into();
    c.into()
}

fn build_tree(left: Expr, right: Expr) -> anyhow::Result<(ErgoTree, String)> {
    // Use Exponentiate::new — happy paths always have (SGroupElement, SBigInt)
    // operands so construction succeeds.
    let node = Exponentiate::new(left, right)
        .map_err(|e| anyhow::anyhow!("Exponentiate::new: {:?}", e))?;
    let body: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Throw-path tree: build the Exponentiate MIR struct directly (bypassing
/// `Exponentiate::new`'s build-time `(SGroupElement, SBigInt)` check). Mirrors
/// the multiply_group::build_throw_tree pattern.
fn build_throw_tree(left: Expr, right: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let node = Exponentiate {
        left: Box::new(left),
        right: Box::new(right),
    };
    let body: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(
    name: &str,
    base: EcPoint,
    exponent: BigInt256,
) -> anyhow::Result<ExponentiateFixture> {
    let (tree, hex) = build_tree(const_group(base), const_bigint(exponent))?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(ExponentiateFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn error_entry(
    name: &str,
    left: Expr,
    right: Expr,
    code: &str,
) -> anyhow::Result<ExponentiateFixture> {
    // Tree is built but sigma-rust eval is NOT run — TS test asserts only
    // the expected error code (multiply_group.rs::error_entry precedent).
    let (_tree, hex) = build_throw_tree(left, right)?;
    Ok(ExponentiateFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

/// Construct a BigInt256 from a 32-byte BE representation. Since the high bit
/// of n (and n-1) is set, `from_be_slice` interprets it as a signed i256 value
/// (negative). Sigma-rust's `bigint256_to_scalar` then applies
/// `from_signed_mod(bi, n)` which lifts back into [0, n). The resulting scalar
/// is what gets multiplied with the base — this exercises the mod-n reduction
/// path's correctness on near-n inputs.
fn bigint256_from_be_32(bytes: [u8; 32]) -> BigInt256 {
    BigInt256::from_be_slice(&bytes).expect("32 bytes fit in BigInt256")
}

pub fn generate() -> anyhow::Result<ExponentiateFixtureFile> {
    let mut entries = Vec::new();

    let g = generator();
    let id = identity();

    // 1. exp_gen_1: g^1 = g (sanity)
    entries.push(success_entry("exp_gen_1", g, BigInt256::from(1i32))?);

    // 2. exp_gen_0: g^0 = identity (mod-n reduces to 0 → identity)
    entries.push(success_entry("exp_gen_0", g, BigInt256::from(0i32))?);

    // 3. exp_gen_random: g^k where k is a deterministic mid-range value
    //    exercising a non-trivial scalar. We use a fixed 32-byte BE pattern
    //    rather than `force_any_val::<BigInt256>()` because `TestRunner::default()`
    //    does NOT use a fixed seed and therefore produces a different value on
    //    every invocation — fixture-gen requires determinism (CLAUDE.md gotcha:
    //    "`cargo run` ... diff against committed must be empty").
    //
    //    Value: arbitrary 32-byte BE pattern with high bit clear (positive
    //    i256 well below I256::MAX). Decimal value approx 2.3e76 — bigger
    //    than 2^254, exercising the full scalar arithmetic without mod-n lift.
    let rand_k_bytes: [u8; 32] = [
        0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
        0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
        0x11, 0x22,
    ];
    let rand_k = bigint256_from_be_32(rand_k_bytes);
    entries.push(success_entry("exp_gen_random", g, rand_k)?);

    // 4. exp_identity_k: identity^k = identity (★ validates the TS identity-base guard)
    //    Use a deterministic non-zero k.
    let nonzero_k = BigInt256::from(12345i32);
    entries.push(success_entry("exp_identity_k", id, nonzero_k)?);

    // 5. exp_gen_minus_1: g^-1 → mod-n reduces to n-1 → g^(n-1) = -g (curve inverse)
    let minus_one =
        BigInt256::from_str_radix("-1", 10).expect("BigInt256 from -1");
    entries.push(success_entry("exp_gen_minus_1", g, minus_one)?);

    // 6. exp_gen_n_minus_1: g^(n-1) via 32-byte BE of (n-1). n's BE encoding
    //    (FF...FE BAAEDCE6 AF48A03B BFD25E8C D0364141) has the high bit set,
    //    so BigInt256::from_be_slice interprets it as a NEGATIVE i256 (twos-
    //    complement). After sigma-rust's from_signed_mod(bi, n) the scalar is
    //    well-defined; whatever sigma-rust computes is our oracle. The TS
    //    handler must produce the same point via its own mod-n reduction.
    //
    //    n - 1 = FF...FE BAAEDCE6 AF48A03B BFD25E8C D0364140
    let n_minus_1_bytes: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36,
        0x41, 0x40,
    ];
    entries.push(success_entry(
        "exp_gen_n_minus_1",
        g,
        bigint256_from_be_32(n_minus_1_bytes),
    )?);

    // 7. exp_gen_n: g^n via 32-byte BE of n. Same i256 reinterpretation as
    //    above; the actual scalar after from_signed_mod is determined by
    //    sigma-rust. This exercises the same mod-n reduction path with a
    //    slightly different residue than n-1.
    //
    //    n = FF...FE BAAEDCE6 AF48A03B BFD25E8C D0364141
    let n_bytes: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36,
        0x41, 0x41,
    ];
    entries.push(success_entry(
        "exp_gen_n",
        g,
        bigint256_from_be_32(n_bytes),
    )?);

    // 8. exp_gen_i256_max: g^(2^255 - 1) — largest positive i256.
    //    BE encoding: 7F FF...FF (32 bytes; high bit clear, rest all 1s).
    let i256_max_bytes: [u8; 32] = [
        0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff,
    ];
    entries.push(success_entry(
        "exp_gen_i256_max",
        g,
        bigint256_from_be_32(i256_max_bytes),
    )?);

    // 9. exp_gen_i256_min: g^(-2^255) — most negative i256.
    //    BE encoding: 80 00...00 (32 bytes; high bit set, rest all 0s).
    let i256_min_bytes: [u8; 32] = [
        0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00,
    ];
    entries.push(success_entry(
        "exp_gen_i256_min",
        g,
        bigint256_from_be_32(i256_min_bytes),
    )?);

    // 10. exp_throw_non_grp_base: Const(SInt, 42) base → throw
    entries.push(error_entry(
        "exp_throw_non_grp_base",
        const_int(42),
        const_bigint(BigInt256::from(1i32)),
        "group-op-input-not-group-element",
    )?);

    // 11. exp_throw_non_bigint_exp: Const(SInt, 42) exponent → throw
    entries.push(error_entry(
        "exp_throw_non_bigint_exp",
        const_group(g),
        const_int(42),
        "predef-input-not-bigint",
    )?);

    Ok(ExponentiateFixtureFile {
        corpus: "eval_exponentiate",
        entries,
    })
}
