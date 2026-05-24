//! Cthreshold conjecture verifier fixtures (phase 2g-combinators Task 8).
//!
//! Recipe (k-of-n Cthreshold, with k real children and n-k simulated):
//!   1. For each simulated child at index i: pick deterministic c_i and z_i.
//!      Compute commitment a_i = g^{z_i} * inverse(pk_i^{c_i}) (backward Schnorr).
//!   2. For each real child at index j: pick deterministic nonce r_j.
//!      Compute commitment a_j = g^{r_j}.
//!   3. Build Fiat-Shamir input: tree-encoded(sb, [a_i per leaf]) || msg.
//!      Hash → root_challenge.
//!   4. Interpolate polynomial Q over GF(2^192) passing through:
//!        (0, root_challenge), (idx_i+1, c_i) for each simulated child (1-based idx).
//!      Polynomial degree = n - k.
//!   5. For each real child at index j: c_j = Q.evaluate(j+1). z_j = r_j + c_j * w_j.
//!   6. Serialize: root_challenge (24) || poly_bytes ((n-k) * 24) ||
//!      z_0 (32) || z_1 (32) || ... || z_{n-1} (32).
//!      Per `sig_serializer.rs:91-108`: no per-child challenges written; the
//!      polynomial encodes (root, sim_challenges) and the verifier reconstructs
//!      every leaf's challenge by polynomial evaluation.
//!   7. Cross-validate.
//!
//! Source:
//!   ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:91-108 (writer)
//!   ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:215-245 (verifier)
//!   ergotree-interpreter/src/sigma_protocol/prover.rs:849-907 (step9_real_threshold)

use crate::cmds::ergoscript::verify::verifier_conj_common::{
    cross_check_with_sigma_rust, dht_real_z, dht_sb_from_secret, dht_simulate, dlog_real_z,
    dlog_sb_from_secret, dlog_secret_scalar, dlog_simulate, fiat_shamir_hash, make_cthreshold,
    root_challenge, scalar_from_seed, scalar_to_bytes, LeafCommitment, SOUNDNESS_BYTES,
};
use crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json;
use anyhow::Result;
use ergo_chain_types::ec_point::{exponentiate, exponentiate_gen};
use ergotree_ir::sigma_protocol::sigma_boolean::{SigmaBoolean, SigmaProofOfKnowledgeTree};
use gf2_192::gf2_192::Gf2_192;
use gf2_192::gf2_192poly::Gf2_192Poly;
use k256::Scalar;
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Serialize)]
pub struct CthresholdPositiveEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    pub expected_result: bool,
}

#[derive(Serialize)]
pub struct CthresholdPositiveFixture {
    pub description: &'static str,
    pub entries: Vec<CthresholdPositiveEntry>,
}

#[derive(Serialize)]
pub struct CthresholdRejectEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct CthresholdRejectFixture {
    pub description: &'static str,
    pub entries: Vec<CthresholdRejectEntry>,
}

#[derive(Serialize)]
pub struct CthresholdMutationEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub mutated_signature_hex: String,
    pub flip_offset: usize,
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct CthresholdMutationFixture {
    pub description: &'static str,
    pub baseline_signature_hex: String,
    pub entries: Vec<CthresholdMutationEntry>,
}

/// A Cthreshold child's role.
#[derive(Clone)]
enum CtChild {
    Simulated {
        sb: SigmaBoolean,
        c: [u8; SOUNDNESS_BYTES],
        z: Scalar,
    },
    Real {
        sb: SigmaBoolean,
        w: Scalar,
        r: Scalar,
    },
}

impl CtChild {
    fn sb(&self) -> &SigmaBoolean {
        match self {
            CtChild::Simulated { sb, .. } | CtChild::Real { sb, .. } => sb,
        }
    }
    fn is_real(&self) -> bool {
        matches!(self, CtChild::Real { .. })
    }
}

fn ct_simulated_dlog(seed: u8, tag: &[u8], msg: &[u8]) -> CtChild {
    let secret = dlog_secret_scalar(b"ergots-fixture/ct-sim-secret", seed);
    let sb = dlog_sb_from_secret(secret);
    let c = fiat_shamir_hash(&{
        let mut buf = tag.to_vec();
        buf.push(seed);
        buf.extend_from_slice(msg);
        buf
    });
    let z = scalar_from_seed(
        b"ergots-fixture/ct-sim-z",
        &{
            let mut buf = tag.to_vec();
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    CtChild::Simulated { sb, c, z }
}

#[allow(dead_code)]
fn ct_simulated_dht(seed: u8, tag: &[u8], msg: &[u8]) -> CtChild {
    let w = scalar_from_seed(b"ergots-fixture/ct-sim-dht-w", &[seed; 32]);
    let h_secret = scalar_from_seed(b"ergots-fixture/ct-sim-dht-h", &[seed.wrapping_add(0x80); 32]);
    let sb = dht_sb_from_secret(w, h_secret);
    let c = fiat_shamir_hash(&{
        let mut buf = tag.to_vec();
        buf.push(seed);
        buf.extend_from_slice(msg);
        buf
    });
    let z = scalar_from_seed(
        b"ergots-fixture/ct-sim-dht-z",
        &{
            let mut buf = tag.to_vec();
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    CtChild::Simulated { sb, c, z }
}

fn ct_real_dlog(seed: u8, tag: &[u8], msg: &[u8]) -> CtChild {
    let w = dlog_secret_scalar(tag, seed);
    let sb = dlog_sb_from_secret(w);
    let r = scalar_from_seed(
        b"ergots-fixture/ct-real-nonce",
        &{
            let mut buf = w.to_bytes().to_vec();
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    CtChild::Real { sb, w, r }
}

fn ct_real_dht(seed: u8, tag: &[u8], msg: &[u8]) -> CtChild {
    let w = scalar_from_seed(tag, &[seed; 32]);
    let h_secret = scalar_from_seed(b"ergots-fixture/ct-real-dht-h", &[seed.wrapping_add(0x80); 32]);
    let sb = dht_sb_from_secret(w, h_secret);
    let r = scalar_from_seed(
        b"ergots-fixture/ct-real-dht-nonce",
        &{
            let mut buf = w.to_bytes().to_vec();
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    CtChild::Real { sb, w, r }
}

fn child_commitment(child: &CtChild) -> Result<LeafCommitment> {
    match child {
        CtChild::Simulated { sb, c, z } => match sb {
            SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pk)) => {
                let a = dlog_simulate(pk, c, *z);
                Ok(LeafCommitment::Dlog { a })
            }
            SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(pk)) => {
                let (a, b) = dht_simulate(pk, c, *z);
                Ok(LeafCommitment::Dht { a, b })
            }
            _ => anyhow::bail!("ct child must be a leaf proposition"),
        },
        CtChild::Real { sb, r, .. } => match sb {
            SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(_)) => {
                Ok(LeafCommitment::Dlog {
                    a: exponentiate_gen(r),
                })
            }
            SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(p)) => {
                let a = exponentiate(&p.g, r);
                let b = exponentiate(&p.h, r);
                Ok(LeafCommitment::Dht { a, b })
            }
            _ => anyhow::bail!("ct real child must be a leaf proposition"),
        },
    }
}

/// Sign a k-of-n Cthreshold. `children` is in the order the tree presents them
/// (index 0..n-1). The number of "Real" entries must equal `k`.
fn sign_flat_cthreshold(
    k: u8,
    children: &[CtChild],
    msg: &[u8],
) -> Result<(SigmaBoolean, Vec<u8>)> {
    let n = children.len();
    anyhow::ensure!(n >= 2, "Cthreshold needs at least 2 children");
    anyhow::ensure!(
        k as usize <= n,
        "Cthreshold k must be ≤ n (got k={}, n={})",
        k,
        n
    );
    let real_count = children.iter().filter(|c| c.is_real()).count();
    anyhow::ensure!(
        real_count == k as usize,
        "sign_flat_cthreshold: expected exactly k={} real children, got {}",
        k,
        real_count
    );

    let items: Vec<SigmaBoolean> = children.iter().map(|c| c.sb().clone()).collect();
    let sb = make_cthreshold(k, items)?;

    let commitments: Vec<LeafCommitment> =
        children.iter().map(child_commitment).collect::<Result<_>>()?;

    let root = root_challenge(&sb, &commitments, msg)?;

    // Build polynomial Q: passes through (0, root) and (idx+1, c_i) for each
    // simulated child. Q.evaluate(j+1) yields the challenge for child j (whether
    // real or simulated — simulated points come back the same, real points
    // give us the challenges we'll sign with).
    let value_at_zero: Gf2_192 = Gf2_192::from(root);
    let mut points: Vec<u8> = Vec::new();
    let mut values: Vec<Gf2_192> = Vec::new();
    for (idx, child) in children.iter().enumerate() {
        if let CtChild::Simulated { c, .. } = child {
            let one_based = (idx + 1) as u8;
            points.push(one_based);
            values.push(Gf2_192::from(*c));
        }
    }
    let poly = Gf2_192Poly::interpolate(&points, &values, value_at_zero)
        .map_err(|e| anyhow::anyhow!("Gf2_192Poly::interpolate: {:?}", e))?;

    // Verify the polynomial encodes the simulated challenges correctly
    // (sanity-check before producing fixture).
    for (idx, child) in children.iter().enumerate() {
        if let CtChild::Simulated { c, .. } = child {
            let one_based = (idx + 1) as u8;
            let evaluated = poly.evaluate(one_based);
            let bytes: [u8; SOUNDNESS_BYTES] = evaluated.into();
            anyhow::ensure!(
                &bytes == c,
                "Cthreshold poly interpolation sanity-check failed at idx {}: {:?} vs {:?}",
                idx,
                bytes,
                c
            );
        }
    }

    // For each child, evaluate the polynomial at one-based index to get its challenge.
    // Then build z values: real children use w*c+r; simulated use the predetermined z.
    let mut z_values: Vec<Scalar> = Vec::with_capacity(n);
    for (idx, child) in children.iter().enumerate() {
        let one_based = (idx + 1) as u8;
        match child {
            CtChild::Simulated { z, .. } => {
                z_values.push(*z);
            }
            CtChild::Real { sb, w, r } => {
                let c_bytes: [u8; SOUNDNESS_BYTES] = poly.evaluate(one_based).into();
                let z = match sb {
                    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(_)) => {
                        dlog_real_z(*r, *w, &c_bytes)
                    }
                    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(_)) => {
                        dht_real_z(*r, *w, &c_bytes)
                    }
                    _ => anyhow::bail!("unsupported leaf"),
                };
                z_values.push(z);
            }
        }
    }

    // Serialize: root || poly_bytes (n-k coefficients) || z_0 || ... || z_{n-1}.
    let poly_bytes = poly.to_bytes();
    anyhow::ensure!(
        poly_bytes.len() == (n - k as usize) * SOUNDNESS_BYTES,
        "polynomial bytes length mismatch: got {} expected {}",
        poly_bytes.len(),
        (n - k as usize) * SOUNDNESS_BYTES
    );

    let mut sig = Vec::new();
    sig.extend_from_slice(&root);
    sig.extend_from_slice(&poly_bytes);
    for z in &z_values {
        sig.extend_from_slice(&scalar_to_bytes(z));
    }

    cross_check_with_sigma_rust(&sb, msg, &sig, "sign_flat_cthreshold")?;
    Ok((sb, sig))
}

// ────────────────────────────────────────────────────────────────────
// Positive entries.
// ────────────────────────────────────────────────────────────────────

fn entry_ct_k_of_n(
    name: &str,
    k: u8,
    n: usize,
    seed_base: u8,
    msg: &[u8],
) -> Result<CthresholdPositiveEntry> {
    let mut children = Vec::with_capacity(n);
    // First k children = real, last n-k = simulated.
    for i in 0..(k as usize) {
        children.push(ct_real_dlog(
            seed_base.wrapping_add(i as u8),
            b"ergots-fixture/ct-real-tag",
            msg,
        ));
    }
    for i in 0..(n - k as usize) {
        children.push(ct_simulated_dlog(
            seed_base.wrapping_add(100 + i as u8),
            b"ergots-fixture/ct-sim-tag",
            msg,
        ));
    }
    let (sb, sig) = sign_flat_cthreshold(k, &children, msg)?;
    Ok(CthresholdPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

fn entry_ct_mixed_real_dht(
    name: &str,
    seed_base: u8,
    msg: &[u8],
) -> Result<CthresholdPositiveEntry> {
    // 2-of-3: real dlog at index 0, real dht at index 1, sim dlog at index 2.
    let children = vec![
        ct_real_dlog(seed_base, b"ergots-fixture/ct-mix-rdlog", msg),
        ct_real_dht(
            seed_base.wrapping_add(1),
            b"ergots-fixture/ct-mix-rdht",
            msg,
        ),
        ct_simulated_dlog(
            seed_base.wrapping_add(2),
            b"ergots-fixture/ct-mix-sim",
            msg,
        ),
    ];
    let (sb, sig) = sign_flat_cthreshold(2, &children, msg)?;
    Ok(CthresholdPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

fn entry_ct_interleaved(
    name: &str,
    seed_base: u8,
    msg: &[u8],
) -> Result<CthresholdPositiveEntry> {
    // 2-of-4: real, sim, real, sim — exercises polynomial interpolation
    // through non-contiguous simulated indices.
    let children = vec![
        ct_real_dlog(seed_base, b"ergots-fixture/ct-il-r0", msg),
        ct_simulated_dlog(seed_base.wrapping_add(1), b"ergots-fixture/ct-il-s1", msg),
        ct_real_dlog(seed_base.wrapping_add(2), b"ergots-fixture/ct-il-r2", msg),
        ct_simulated_dlog(seed_base.wrapping_add(3), b"ergots-fixture/ct-il-s3", msg),
    ];
    let (sb, sig) = sign_flat_cthreshold(2, &children, msg)?;
    Ok(CthresholdPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

fn entry_ct_n_of_n(
    name: &str,
    n: usize,
    seed_base: u8,
    msg: &[u8],
) -> Result<CthresholdPositiveEntry> {
    // n-of-n: every child is real, polynomial is constant (degree 0, no extra bytes).
    let mut children = Vec::new();
    for i in 0..n {
        children.push(ct_real_dlog(
            seed_base.wrapping_add(i as u8),
            b"ergots-fixture/ct-non-tag",
            msg,
        ));
    }
    let (sb, sig) = sign_flat_cthreshold(n as u8, &children, msg)?;
    Ok(CthresholdPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

pub fn generate() -> Result<CthresholdPositiveFixture> {
    let mut entries = Vec::new();
    entries.push(entry_ct_k_of_n("ct-2-of-3-dlog", 2, 3, 1, b"")?);
    entries.push(entry_ct_k_of_n("ct-3-of-5-dlog", 3, 5, 10, b"three-of-five")?);
    entries.push(entry_ct_k_of_n("ct-1-of-3-dlog", 1, 3, 20, b"one-of-three")?);
    entries.push(entry_ct_n_of_n("ct-3-of-3-all-real", 3, 30, b"all-real")?);
    entries.push(entry_ct_mixed_real_dht("ct-2-of-3-real-dht-mix", 40, b"dht-mix")?);
    entries.push(entry_ct_interleaved("ct-2-of-4-interleaved", 50, b"interleaved-msg")?);
    entries.push(entry_ct_k_of_n("ct-2-of-5-dlog", 2, 5, 60, b"two-of-five")?);
    Ok(CthresholdPositiveFixture {
        description: "Cthreshold conjecture positive fixtures (phase 2g-combinators Task 8). \
            k-of-n threshold with polynomial-based challenge derivation. Layout: \
            root (24) || poly_bytes ((n-k)*24) || z_0 (32) || ... || z_{n-1} (32). \
            The polynomial Q passes through (0, root) and (idx+1, sim_c) for each \
            simulated child; the verifier reconstructs Q from poly_bytes+root, then \
            evaluates at each 1-based child index for that child's challenge. \
            Includes 2-of-3, 3-of-5, 1-of-3, 3-of-3 (all-real, degree-0 poly), \
            mixed real-DH-tuple, interleaved real/sim layout, 2-of-5. Each \
            cross-validated against sigma-rust's verify_signature.",
        entries,
    })
}

// ────────────────────────────────────────────────────────────────────
// Baseline + reject + mutation.
// ────────────────────────────────────────────────────────────────────

pub fn baseline_ct_2_of_3() -> Result<(SigmaBoolean, Vec<u8>, Vec<u8>)> {
    let msg: Vec<u8> = b"baseline-ct".to_vec();
    let children = vec![
        ct_real_dlog(0x42, b"ergots-fixture/ct-baseline-r0", &msg),
        ct_real_dlog(0x43, b"ergots-fixture/ct-baseline-r1", &msg),
        ct_simulated_dlog(0x44, b"ergots-fixture/ct-baseline-s2", &msg),
    ];
    let (sb, sig) = sign_flat_cthreshold(2, &children, &msg)?;
    Ok((sb, msg, sig))
}

pub fn generate_reject() -> Result<CthresholdRejectFixture> {
    let mut entries = Vec::new();
    let (sb, msg, sig) = baseline_ct_2_of_3()?;
    // 2-of-3 Cthreshold: root(24) || poly((3-2)*24=24) || 3 z's (3*32=96) = 144 bytes.
    debug_assert_eq!(sig.len(), 144, "Cthreshold 2-of-3 sig should be 144 bytes");

    // 1. Truncated below the polynomial-read minimum (root 24 + poly 24 = 48).
    //    Polynomial read is strict (sig_serializer.rs:222-224 `read_exact`);
    //    sigma-rust throws SigParsingError::CthresholdCoeffRead. Our verifier
    //    surfaces this as VerifyError code 'truncated-signature'.
    entries.push(CthresholdRejectEntry {
        name: "ct-truncated-sig".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: hex::encode(&sig[..30]),
        expected_outcome: "truncated-signature".to_string(),
    });

    // 1b. Truncated in the scalar area (root 24 + poly 24 + partial z's).
    //     Scalar reads are LENIENT (sig_serializer.rs:250-255 `read_scalar`
    //     reads up to GROUP_SIZE and left-pads with zeros — prover-side
    //     leading-zero stripping is on-wire). Parse succeeds; recovered
    //     z's are near-zero so the Fiat-Shamir recomputation diverges from
    //     the root challenge and verification returns false. Mirrors the
    //     class of mainnet proof that surfaced at h=220541 (a 55-byte P2PK
    //     signature where the prover stripped one leading zero from z).
    entries.push(CthresholdRejectEntry {
        name: "ct-truncated-scalars".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: hex::encode(&sig[..50]),
        expected_outcome: "returns-false".to_string(),
    });

    // 2. Empty.
    entries.push(CthresholdRejectEntry {
        name: "ct-empty-sig".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: String::new(),
        expected_outcome: "empty-signature".to_string(),
    });

    // 3. Zero out the polynomial bytes — Q.evaluate(j) will return root for all j,
    //    giving wrong per-leaf challenges → verifier rejects.
    let mut bad = sig.clone();
    for byte in &mut bad[24..48] {
        *byte = 0;
    }
    entries.push(CthresholdRejectEntry {
        name: "ct-zeroed-polynomial".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: hex::encode(&bad),
        expected_outcome: "returns-false".to_string(),
    });

    Ok(CthresholdRejectFixture {
        description: "Cthreshold reject fixtures: truncated, empty, zeroed-polynomial \
            variants of a baseline 2-of-3 Cthreshold. Verifier must reject (error or false).",
        entries,
    })
}

pub fn generate_mutation() -> Result<CthresholdMutationFixture> {
    let (sb, msg, sig) = baseline_ct_2_of_3()?;
    let sig_len = sig.len();
    debug_assert_eq!(sig_len, 144);

    let mut entries = Vec::with_capacity(sig_len);
    for offset in 0..sig_len {
        let mut mutated = sig.clone();
        mutated[offset] ^= 0xff;
        // Annotate which region the flip lands in for diagnostic clarity in the fixture.
        let region = if offset < 24 {
            "root-challenge"
        } else if offset < 48 {
            "polynomial-bytes"
        } else {
            "scalar-z"
        };
        entries.push(CthresholdMutationEntry {
            name: format!("ct-flip-byte-{:03}-{}", offset, region),
            sigma_boolean_json: sigma_boolean_to_json(&sb),
            message_hex: hex::encode(&msg),
            mutated_signature_hex: hex::encode(&mutated),
            flip_offset: offset,
            expected_outcome: "false-or-error".to_string(),
        });
    }

    Ok(CthresholdMutationFixture {
        description: "Cthreshold byte-flip mutation fixtures: 144 single-byte-flip \
            mutations of a baseline 2-of-3 Cthreshold signature. Covers the root \
            challenge zone (0-23), polynomial bytes zone (24-47), and scalar-z zone \
            (48-143). The verifier must return false or throw VerifyError on every \
            entry — flipping any byte invalidates either a challenge, polynomial \
            coefficient, or response.",
        baseline_signature_hex: hex::encode(&sig),
        entries,
    })
}
