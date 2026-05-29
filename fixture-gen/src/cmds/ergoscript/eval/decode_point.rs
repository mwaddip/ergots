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
//! Identity + length convention (iter-24, mainnet h=1,111,884): sigma-rust
//! `EcPoint::scorex_parse` (`ec_point.rs:139-151`) does `read_exact(&mut [0u8;33])`
//! then: `buf[0] != 0` ⇒ strict SEC1 decode, else ⇒ identity (point-at-infinity).
//! So ANY input whose first byte is 0x00 decodes to identity — bytes 1..32 are
//! NEVER inspected (not just the canonical all-zero encoding). And
//! `sigma_parse_bytes` wraps a cursor with no full-consumption check, so input
//! LONGER than 33 bytes is accepted (trailing bytes ignored); SHORTER than 33
//! throws (read_exact underflow). The TS adapter `crypto/secp256k1.ts:decodePoint`
//! mirrors this exactly as of iter-24 — it was previously stricter (exact-33 +
//! all-zero identity), which halted the validator at h=1,111,884 on a 514-byte
//! 0x00-lead `SELF.R4[3..]` slice of an embedded ErgoTree.
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

    // Coverage (6 scenarios):
    //
    //   Happy paths (4):
    //     - dp_generator      : curve generator point. Canonical 33-byte
    //                           SEC1-compressed encoding via EcPoint::sigma_serialize_bytes.
    //     - dp_identity       : 33 zero bytes → point-at-infinity (Ergo identity
    //                           convention, sigma-rust `ec_point.rs:139-151`).
    //     - dp_zero_lead_34   : 34 bytes, lead 0x00 + NON-ZERO body → identity.
    //                           Boundary: one byte past the 33-byte point (the old
    //                           strict exact-33 adapter rejected this). Non-zero
    //                           bytes 1..32 prove they are never inspected; the
    //                           34th byte proves trailing tolerance. (iter-24)
    //     - dp_zero_lead_long : 514 bytes, lead 0x00 + non-zero body → identity.
    //                           Mirrors the real on-chain shape that triggered
    //                           iter-24 (`SELF.R4[3..]`, h=1,111,884) — a long
    //                           0x00-lead slice of an embedded ErgoTree. The exact
    //                           on-chain bytes are a permanent regression via the
    //                           mainnet-validate walker; this fixture pins the
    //                           property in the offline suite. (iter-24)
    //
    //   (No `dp_arbitrary` scenario: `force_any_val::<EcPoint>()` is
    //   entropy-seeded (`TestRunner::default()`) — NON-deterministic across runs
    //   (see `multiply_group.rs::mg_distinct_points`) — and a random point would
    //   add nothing over the explicit cases. Mirrors the
    //   `sgroup_elem_get_encoded.rs` and `create_prove_dlog.rs` precedent of
    //   using explicit `generator()` + `identity()` only.)
    //
    //   Error paths (2):
    //     - dp_wrong_length_32 : 32 bytes (< 33) — read_exact underflow, throws.
    //                            (34 bytes is NO LONGER an error — see
    //                            dp_zero_lead_34; trailing bytes are tolerated.)
    //     - dp_off_curve       : 33 bytes with leading 0x04 tag (the SEC1
    //                            uncompressed-marker byte; invalid when the encoding
    //                            is supposed to be the 33-byte compressed form) —
    //                            triggers @noble/curves' "bad point" rejection.
    //                            The first byte is non-zero, so the 0x00-lead
    //                            identity short-circuit doesn't fire.

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

    // 3. iter-24: 34-byte 0x00-lead buffer with a NON-ZERO body → identity.
    //    Boundary case (one byte past the 33-byte point); the old strict
    //    exact-33 adapter rejected this. `success_entry` runs real sigma-rust
    //    eval, so if sigma-rust did NOT tolerate trailing bytes this would fail
    //    to generate — making the fixture self-validating.
    let mut zero_lead_34 = vec![0i8; 34];
    for i in 1..34 {
        zero_lead_34[i] = (((i % 254) + 1) as u8) as i8; // non-zero body
    }
    entries.push(success_entry("dp_zero_lead_34", zero_lead_34)?);

    // 4. iter-24: 514-byte 0x00-lead buffer (mirrors the on-chain SELF.R4[3..]
    //    slice at h=1,111,884) with a non-zero body → identity.
    let mut zero_lead_long = vec![0i8; 514];
    for i in 1..514 {
        zero_lead_long[i] = (((i % 254) + 1) as u8) as i8; // non-zero body
    }
    entries.push(success_entry("dp_zero_lead_long", zero_lead_long)?);

    // 5. Wrong length: 32 bytes (< 33) — read_exact underflow, throws.
    entries.push(error_entry(
        "dp_wrong_length_32",
        vec![0i8; 32],
        "decode-point-invalid",
    )?);

    // 6. Off-curve: 33 bytes with tag 0x04 — the SEC1 uncompressed-marker byte,
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
