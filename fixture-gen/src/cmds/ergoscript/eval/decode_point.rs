//! DecodePoint arm — 33-byte SEC1-compressed Coll[Byte] → GroupElement.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/decode_point.rs:14-30
//!   ctx.add_jit_cost(300)?;                              // Pattern A: BEFORE eval-child
//!   let point_bytes = self.input.eval(env, ctx)?
//!       .try_extract_into::<Vec<u8>>()?;
//!   let point: EcPoint = SigmaSerializable::sigma_parse_bytes(&point_bytes)
//!       .map_err(|_| Misc(format!(
//!           "DecodePoint: Failed to parse EC point from bytes {:?}",
//!           point_bytes,
//!       )))?;
//!   Ok(point.into())
//!
//! Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(300).
//!
//! Identity convention: sigma-rust `EcPoint::scorex_parse` treats any payload
//! whose first byte is 0x00 as the curve identity (point-at-infinity). The TS
//! adapter at `crypto/secp256k1.ts:decodePoint` is STRICTER — it requires all
//! 33 bytes to be zero — so a hand-crafted `[0x00, 0xAB, ...]` would diverge.
//! All in-corpus fixtures encode identity as 33 zero bytes (the canonical
//! `EcPoint::scorex_serialize` output at `ec_point.rs:127-137`), so the
//! divergence is unreachable through the standard parse path.
//!
//! Build-time type guard: `DecodePoint::try_build` (sigma-rust
//! `ergotree-ir/src/mir/decode_point.rs:43-48`) calls
//! `input.check_post_eval_tpe(&SType::SColl(SByte))?`, so non-Coll[Byte]
//! inputs cannot be serialized via the standard path. The TS-side
//! `'predef-input-not-byte-array'` assertion is covered by an inline TS test
//! that calls `evalExpr` directly with a hand-built MIR node (byte_array_to_long
//! precedent).

use ergo_chain_types::ec_point::{generator, identity};
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::decode_point::DecodePoint;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct DecodePointFixture {
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
pub struct DecodePointFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<DecodePointFixture>,
}

fn build_tree(bytes: Vec<i8>) -> anyhow::Result<(ErgoTree, String)> {
    let node = DecodePoint::try_build(Expr::Const(bytes.into()))
        .map_err(|e| anyhow::anyhow!("DecodePoint::try_build: {:?}", e))?;
    let expr: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, bytes: Vec<i8>) -> anyhow::Result<DecodePointFixture> {
    let (tree, hex) = build_tree(bytes)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(DecodePointFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn error_entry(name: &str, bytes: Vec<i8>, code: &str) -> anyhow::Result<DecodePointFixture> {
    // For error entries we still build & serialize the tree (so the TS parser
    // can decode it the same way), but we don't run sigma-rust eval against it;
    // the TS test asserts only the expected error code (per existing fixture
    // convention used by byte_array_to_bigint).
    let (_tree, hex) = build_tree(bytes)?;
    Ok(DecodePointFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<DecodePointFixtureFile> {
    let mut entries = Vec::new();

    // Coverage (5 scenarios):
    //
    //   Happy paths (2):
    //     - dp_generator   : curve generator point. Canonical 33-byte
    //                        SEC1-compressed encoding via EcPoint::sigma_serialize_bytes.
    //     - dp_identity    : 33 zero bytes → point-at-infinity (Ergo identity convention,
    //                        sigma-rust `ec_point.rs:127-152`).
    //
    //   (No `dp_arbitrary` scenario: `force_any_val::<EcPoint>()` is
    //   deterministic under the proptest seed and happens to produce the same
    //   bytes as `generator()` on the first call — would be a duplicate. Mirrors
    //   the `sgroup_elem_get_encoded.rs` and `create_prove_dlog.rs` precedent
    //   of using explicit `generator()` + `identity()` only.)
    //
    //   Error paths (3):
    //     - dp_wrong_length_32 : 32 bytes instead of 33 — adapter throws on length mismatch.
    //     - dp_wrong_length_34 : 34 bytes — same length-mismatch failure.
    //     - dp_off_curve       : 33 bytes with leading 0x04 tag (the SEC1
    //                            uncompressed-marker byte; invalid when the encoding
    //                            is supposed to be the 33-byte compressed form) —
    //                            triggers @noble/curves' "bad point" rejection.
    //                            The first byte is non-zero, so the all-zero-identity
    //                            short-circuit doesn't fire.

    // 1. Generator point.
    let gen_bytes: Vec<i8> = generator()
        .sigma_serialize_bytes()?
        .into_iter()
        .map(|b| b as i8)
        .collect();
    entries.push(success_entry("dp_generator", gen_bytes)?);

    // 2. Identity (33 zero bytes — canonical Ergo identity encoding).
    let identity_bytes: Vec<i8> = identity()
        .sigma_serialize_bytes()?
        .into_iter()
        .map(|b| b as i8)
        .collect();
    entries.push(success_entry("dp_identity", identity_bytes)?);

    // 3. Wrong length: 32 bytes (too short).
    entries.push(error_entry(
        "dp_wrong_length_32",
        vec![0i8; 32],
        "decode-point-invalid",
    )?);

    // 4. Wrong length: 34 bytes (too long).
    entries.push(error_entry(
        "dp_wrong_length_34",
        vec![0i8; 34],
        "decode-point-invalid",
    )?);

    // 5. Off-curve: 33 bytes with tag 0x04 — the SEC1 uncompressed-marker byte,
    //    invalid when the encoding is supposed to be the 33-byte compressed form.
    let mut off_curve = vec![0i8; 33];
    off_curve[0] = 0x04;
    for i in 1..33 {
        off_curve[i] = i as i8;
    }
    entries.push(error_entry("dp_off_curve", off_curve, "decode-point-invalid")?);

    Ok(DecodePointFixtureFile {
        corpus: "eval_decode_point",
        entries,
    })
}
