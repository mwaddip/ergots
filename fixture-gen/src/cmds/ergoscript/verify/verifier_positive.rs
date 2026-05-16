//! V1 positive verifier fixtures (phase 2g-medium Task 6).
//!
//! Generates real (sb, msg, sig) triples for the leaf-only verifier scope
//! (ProveDlog, ProveDhTuple). For full determinism across runs we build
//! each signature manually using sigma-rust's public primitives:
//!
//!   1. derive a 32-byte secret w from a seed
//!   2. derive a 32-byte nonce r deterministically via blake2b256(domain || seed || msg)
//!   3. compute commitment a = G^r (or a = g^r, b = h^r for DH-tuple)
//!   4. build Fiat-Shamir input: LEAF_PREFIX | put_i16_be(prop.len) | prop |
//!      put_i16_be(commitment.len) | commitment | message
//!      (matches `fiat_shamir.rs:139-203`)
//!   5. hash with blake2b256 → first 24 bytes = challenge e
//!   6. compute z = r + e * w (mod n)   (matches `dlog_protocol.rs:155-166`)
//!   7. serialize as challenge_bytes(24) || z_bytes(32)
//!
//! Bypassing `TestProver::prove` is necessary because that path calls
//! `interactive_prover::first_message()` which uses OS randomness, making
//! fixtures non-reproducible. Our manual recipe matches the verifier's
//! commitment-recovery equation byte-for-byte (`dlog_protocol.rs:173-184`,
//! `dht_protocol.rs:132-157`) so the produced signatures verify in both
//! sigma-rust and the TS implementation.
//!
//! Cross-validation: a self-check using sigma-rust's
//! `dlog_protocol::interactive_prover::compute_commitment` confirms that
//! the recomputed commitment matches our `a` before writing the fixture,
//! catching any signing-math mistake at fixture-gen time.

use crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json;
use anyhow::Result;
use ergo_chain_types::ec_point::{exponentiate, exponentiate_gen, generator, inverse};
use ergo_chain_types::EcPoint;
use ergotree_interpreter::sigma_protocol::verifier::verify_signature;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDhTuple, ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp,
};
use k256::elliptic_curve::ops::Reduce;
use k256::{Scalar, U256};
use serde::Serialize;
use serde_json::Value as JsonValue;
use sigma_util::hash::blake2b256_hash;

#[derive(Serialize)]
pub struct PositiveEntry {
    pub name: String,
    /// Discriminated-union JSON tree matching the TS SigmaBoolean shape.
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    /// Always `true` for positive entries.
    pub expected_result: bool,
}

#[derive(Serialize)]
pub struct PositiveFixture {
    pub description: &'static str,
    pub entries: Vec<PositiveEntry>,
}

/// Derive a scalar (in [1, n-1]) deterministically from a domain tag and seed
/// bytes. Uses `Scalar::reduce_bytes` (matching sigma-rust's BIP340-style
/// nonce derivation in `dlog_protocol.rs:142`).
fn scalar_from_seed(tag: &[u8], bytes: &[u8]) -> Scalar {
    let mut input = Vec::with_capacity(tag.len() + bytes.len());
    input.extend_from_slice(tag);
    input.extend_from_slice(bytes);
    let hash = blake2b256_hash(&input);
    let arr: [u8; 32] = *hash;
    <Scalar as Reduce<U256>>::reduce_bytes(&arr.into())
}

/// Construct a fresh scalar with the secret seed deterministically built from
/// `seed`. Avoids `from_repr` failures (the seed may map above the curve
/// order) by going through `reduce_bytes`.
fn dlog_secret_scalar(seed: u8) -> Scalar {
    let seed_bytes = [seed; 32];
    scalar_from_seed(b"ergots-fixture/dlog-secret", &seed_bytes)
}

/// Deterministic nonce scalar for a (secret, message) pair.
fn nonce_scalar(secret_tag: &str, w: &Scalar, msg: &[u8]) -> Scalar {
    let w_bytes: [u8; 32] = w.to_bytes().into();
    let mut input = Vec::with_capacity(32 + msg.len() + 16);
    input.extend_from_slice(secret_tag.as_bytes());
    input.extend_from_slice(&w_bytes);
    input.extend_from_slice(msg);
    let hash = blake2b256_hash(&input);
    let arr: [u8; 32] = *hash;
    <Scalar as Reduce<U256>>::reduce_bytes(&arr.into())
}

/// Convert a 32-byte big-endian scalar value into bytes.
fn scalar_to_bytes(s: &Scalar) -> [u8; 32] {
    s.to_bytes().into()
}

/// Build the `propBytes` for a leaf — wraps the SigmaBoolean in an
/// `ErgoTree(v0, constSegregation=true)` and serializes. This is the same
/// shape `fiat_shamir.rs:148-157` writes for each leaf during Fiat-Shamir
/// tree construction.
fn prop_bytes(sb: &SigmaBoolean) -> Result<Vec<u8>> {
    let sigma_prop = SigmaProp::new(sb.clone());
    let constant: ergotree_ir::mir::constant::Constant = sigma_prop.into();
    let body: Expr = constant.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &body)?;
    Ok(tree.sigma_serialize_bytes()?)
}

/// Construct the Fiat-Shamir input for a single leaf and append the message,
/// mirroring `fiat_shamir.rs::fiat_shamir_write_bytes` (LEAF_PREFIX = 1,
/// `put_i16_be_bytes` = 2-byte big-endian for lengths) plus the verifier's
/// `++ message` step (`verifier.rs:117-118`).
///
/// Bytes are written manually so we don't pull in trait imports for
/// `WriteSigmaVlqExt` / `std::io::Write` — the format is fully specified by
/// the leaf-only path.
fn build_fiat_shamir_input(prop: &[u8], commitment: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    let prop_len = i16::try_from(prop.len()).expect("prop fits in i16");
    let cmt_len = i16::try_from(commitment.len()).expect("commitment fits in i16");
    let mut data = Vec::with_capacity(1 + 2 + prop.len() + 2 + commitment.len() + message.len());
    data.push(1u8); // LEAF_PREFIX
    data.extend_from_slice(&prop_len.to_be_bytes());
    data.extend_from_slice(prop);
    data.extend_from_slice(&cmt_len.to_be_bytes());
    data.extend_from_slice(commitment);
    data.extend_from_slice(message);
    Ok(data)
}

/// Take the first 24 bytes of blake2b-256 — matches
/// `fiat_shamir.rs:70-76 (fiat_shamir_hash_fn)` and the verifier's
/// expected challenge derivation (`verifier.rs:123`).
fn fiat_shamir_challenge_bytes(input: &[u8]) -> [u8; 24] {
    let hash = blake2b256_hash(input);
    let mut out = [0u8; 24];
    out.copy_from_slice(&hash[..24]);
    out
}

/// Convert a 24-byte challenge to a Scalar via left-pad with 8 zero bytes
/// then reduce mod n. Matches `wscalar.rs:69-76` (`From<&Challenge> for Scalar`).
fn challenge_to_scalar(challenge: &[u8; 24]) -> Scalar {
    let mut padded = [0u8; 32];
    padded[8..].copy_from_slice(challenge);
    <Scalar as Reduce<U256>>::reduce_bytes(&padded.into())
}

/// Sign a single ProveDlog leaf using a deterministic nonce. Returns the
/// 56-byte signature (24-byte challenge || 32-byte z).
fn sign_prove_dlog(
    secret_w: Scalar,
    sb: &SigmaBoolean,
    message: &[u8],
) -> Result<Vec<u8>> {
    // Nonce: r deterministically derived from secret + message.
    let r = nonce_scalar("ergots-fixture/dlog-nonce", &secret_w, message);
    // Commitment: a = G^r.
    let a: EcPoint = exponentiate_gen(&r);
    let a_bytes = a.sigma_serialize_bytes()?;

    // Fiat-Shamir challenge.
    let prop = prop_bytes(sb)?;
    let fs_input = build_fiat_shamir_input(&prop, &a_bytes, message)?;
    let challenge_bytes = fiat_shamir_challenge_bytes(&fs_input);
    let e = challenge_to_scalar(&challenge_bytes);

    // z = r + e * w  (mod n)  — matches dlog_protocol.rs:162-165
    let z = r + e * secret_w;
    let z_bytes: [u8; 32] = scalar_to_bytes(&z);

    // Self-check: recover commitment from (e, z) and compare against `a`.
    // Verifier's recovery equation (dlog_protocol.rs:173-184):
    //   a = G^z * inverse(pk^e)
    // Computed directly in additive group ops; equivalent to compute_commitment
    // but doesn't require access to the private `Challenge` type.
    if let SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pk)) = sb {
        let g_z = exponentiate_gen(&z);
        let pk_e = exponentiate(&pk.h, &e);
        let recovered = g_z * &inverse(&pk_e);
        anyhow::ensure!(
            recovered == a,
            "sign_prove_dlog self-check FAILED: recovered commitment != a"
        );
    }

    // Serialize signature: challenge || z.
    let mut out = Vec::with_capacity(24 + 32);
    out.extend_from_slice(&challenge_bytes);
    out.extend_from_slice(&z_bytes);
    Ok(out)
}

/// Sign a single ProveDhTuple leaf using a deterministic nonce. Returns the
/// 56-byte signature (24-byte challenge || 32-byte z).
fn sign_prove_dh_tuple(
    secret_w: Scalar,
    sb: &SigmaBoolean,
    message: &[u8],
) -> Result<Vec<u8>> {
    let (g, h, u, v) = if let SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(p)) = sb {
        ((*p.g).clone(), (*p.h).clone(), (*p.u).clone(), (*p.v).clone())
    } else {
        anyhow::bail!("sign_prove_dh_tuple: not a ProveDhTuple");
    };

    // Nonce.
    let r = nonce_scalar("ergots-fixture/dh-nonce", &secret_w, message);

    // Commitments: a = g^r, b = h^r.
    let a: EcPoint = exponentiate(&g, &r);
    let b: EcPoint = exponentiate(&h, &r);

    // Concatenate the bytes of FirstDhTupleProverMessage as the prover sends
    // them (a_bytes || b_bytes) — matches `dht_protocol.rs:33-38`.
    let mut commitment = Vec::new();
    commitment.extend_from_slice(&a.sigma_serialize_bytes()?);
    commitment.extend_from_slice(&b.sigma_serialize_bytes()?);

    // Fiat-Shamir challenge.
    let prop = prop_bytes(sb)?;
    let fs_input = build_fiat_shamir_input(&prop, &commitment, message)?;
    let challenge_bytes = fiat_shamir_challenge_bytes(&fs_input);
    let e = challenge_to_scalar(&challenge_bytes);

    // z = r + e * w  (mod n)  — matches dht_protocol.rs:117-122
    let z = r + e * secret_w;
    let z_bytes: [u8; 32] = scalar_to_bytes(&z);

    // Self-check: g^z =? a * u^e   (dht_protocol.rs:130).
    // recovered_a = g^z * inverse(u^e) must equal a.
    let g_to_z = exponentiate(&g, &z);
    let u_to_e = exponentiate(&u, &e);
    let recovered_a_first = g_to_z * &inverse(&u_to_e);
    anyhow::ensure!(
        recovered_a_first == a,
        "sign_prove_dh_tuple self-check FAILED: recovered a != a"
    );
    let h_to_z = exponentiate(&h, &z);
    let v_to_e = exponentiate(&v, &e);
    let recovered_b = h_to_z * &inverse(&v_to_e);
    anyhow::ensure!(
        recovered_b == b,
        "sign_prove_dh_tuple self-check FAILED: recovered b != b"
    );

    let mut out = Vec::with_capacity(24 + 32);
    out.extend_from_slice(&challenge_bytes);
    out.extend_from_slice(&z_bytes);
    Ok(out)
}

/// Build the SigmaBoolean for a ProveDlog leaf with secret w.
fn dlog_sb_from_secret(w: Scalar) -> SigmaBoolean {
    let pk = ProveDlog::new(exponentiate_gen(&w));
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pk))
}

/// Build a deterministic ProveDhTuple SigmaBoolean from a single seed.
/// Constructs `g = G` (generator), `h = G^h_secret`, then `u = g^w = G^w`,
/// `v = h^w` (matches DhTupleProverInput::random recipe in
/// `private_input.rs:154-167`).
fn dht_sb_from_secret(w: Scalar, h_secret: Scalar) -> SigmaBoolean {
    let g = generator();
    let h = exponentiate_gen(&h_secret);
    let u = exponentiate_gen(&w);
    let v = exponentiate(&h, &w);
    let pk = ProveDhTuple::new(g, h, u, v);
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(pk))
}

/// Cross-check: pass the (sb, msg, sig) triple through sigma-rust's own
/// `verify_signature` (verifier.rs:91-111). Fails fixture-gen if sigma-rust
/// rejects the signature — guaranteeing that any V1 positive entry the TS
/// verifier accepts is also accepted by the reference implementation.
fn cross_check_with_sigma_rust(
    sb: &SigmaBoolean,
    message: &[u8],
    signature: &[u8],
    label: &str,
) -> Result<()> {
    let result = verify_signature(sb.clone(), message, signature)
        .map_err(|e| anyhow::anyhow!("{}: sigma-rust verifier errored: {:?}", label, e))?;
    anyhow::ensure!(
        result,
        "{}: sigma-rust verify_signature returned false — bad fixture!",
        label
    );
    Ok(())
}

fn entry_prove_dlog(name: &str, seed: u8, message: &[u8]) -> Result<PositiveEntry> {
    let w = dlog_secret_scalar(seed);
    let sb = dlog_sb_from_secret(w);
    let sig = sign_prove_dlog(w, &sb, message)?;
    cross_check_with_sigma_rust(&sb, message, &sig, &format!("entry_prove_dlog({})", name))?;
    Ok(PositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(message),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

fn entry_prove_dh_tuple(name: &str, seed: u8, message: &[u8]) -> Result<PositiveEntry> {
    let w = scalar_from_seed(b"ergots-fixture/dht-secret-w", &[seed; 32]);
    let h_secret = scalar_from_seed(b"ergots-fixture/dht-h-secret", &[seed.wrapping_add(0x80); 32]);
    let sb = dht_sb_from_secret(w, h_secret);
    let sig = sign_prove_dh_tuple(w, &sb, message)?;
    cross_check_with_sigma_rust(&sb, message, &sig, &format!("entry_prove_dh_tuple({})", name))?;
    Ok(PositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(message),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

/// Build the baseline ProveDlog (sb, msg, sig) triple — the simplest entry
/// (seed=1, empty message). Reused by the mutation generator.
///
/// Cross-checked against sigma-rust's `verify_signature` to guarantee the
/// baseline is a real valid signature (mutations operate on a known-good base).
pub fn build_baseline_triple() -> Result<(SigmaBoolean, Vec<u8>, Vec<u8>)> {
    let w = dlog_secret_scalar(1);
    let sb = dlog_sb_from_secret(w);
    let message: Vec<u8> = Vec::new();
    let sig = sign_prove_dlog(w, &sb, &message)?;
    cross_check_with_sigma_rust(&sb, &message, &sig, "build_baseline_triple")?;
    Ok((sb, message, sig))
}

pub fn generate() -> Result<PositiveFixture> {
    let mut entries = Vec::new();

    // 5 ProveDlog entries — varied secret seeds + message lengths.
    let dlog_cases: Vec<(u8, &[u8])> = vec![
        (1, b"" as &[u8]),
        (2, b"a"),
        (3, b"abcdef"),
        (4, &[0u8; 32]),
        (5, &[0xff; 100]),
    ];
    for (i, (seed, msg)) in dlog_cases.into_iter().enumerate() {
        entries.push(entry_prove_dlog(&format!("prove-dlog-{}", i), seed, msg)?);
    }

    // 5 ProveDhTuple entries.
    let dht_cases: Vec<(u8, &[u8])> = vec![
        (0x10, b"" as &[u8]),
        (0x20, b"x"),
        (0x30, b"hello-dht"),
        (0x40, &[0u8; 16]),
        (0x50, &[0xaa; 64]),
    ];
    for (i, (seed, msg)) in dht_cases.into_iter().enumerate() {
        entries.push(entry_prove_dh_tuple(
            &format!("prove-dh-tuple-{}", i),
            seed,
            msg,
        )?);
    }

    Ok(PositiveFixture {
        description: "V1 positive verifier fixtures (phase 2g-medium Task 6) — manually-signed (sb, msg, sig) triples using sigma-rust public primitives with deterministic nonces. Each signature is self-checked via the verifier's commitment-recovery equation (G^z * inverse(pk^e) == a) before write.",
        entries,
    })
}
