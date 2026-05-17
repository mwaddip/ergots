//! Cor conjecture verifier fixtures (phase 2g-combinators Task 8).
//!
//! Recipe (Cor of n leaves, real leaf is LAST):
//!   1. For each simulated child i = 0..n-1: pick deterministic c_i and z_i.
//!      Compute commitment a_i = g^{z_i} * inverse(pk_i^{c_i}) (backward Schnorr).
//!   2. For the REAL last child: pick deterministic nonce r_last.
//!      Compute commitment a_last = g^{r_last}.
//!   3. Build Fiat-Shamir input: tree-encoded(sb, [a_i bytes per leaf]) || msg.
//!      Hash → root_challenge.
//!   4. c_last = root_challenge XOR c_0 XOR c_1 XOR ... XOR c_{n-2}.
//!   5. z_last = r_last + c_last * w_last.
//!   6. Serialize: root_challenge (24) || c_0 (24) || z_0 (32) || c_1 (24) || z_1 (32)
//!      || ... || z_last (32).
//!      Per `sig_serializer.rs:79-90`: the LAST child's challenge is NOT written.
//!   7. Cross-validate.
//!
//! Convention: real leaf is placed LAST so the verifier's XOR-derive path
//! (which always derives the LAST child's challenge) naturally targets it.
//!
//! Source:
//!   ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:79-90 (writer)
//!   ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:187-214 (verifier)
//!   ergotree-interpreter/src/sigma_protocol/prover.rs:817-846 (step9_real_or)

use crate::cmds::ergoscript::verify::verifier_conj_common::{
    cross_check_with_sigma_rust, dht_real_z, dht_sb_from_secret, dht_simulate, dlog_real_z,
    dlog_sb_from_secret, dlog_secret_scalar, dlog_simulate, fiat_shamir_hash, make_cor,
    root_challenge, scalar_from_seed, scalar_to_bytes, xor_challenge, LeafCommitment, SOUNDNESS_BYTES,
};
use crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json;
use anyhow::Result;
use ergo_chain_types::ec_point::{exponentiate, exponentiate_gen};
use ergotree_ir::sigma_protocol::sigma_boolean::{SigmaBoolean, SigmaProofOfKnowledgeTree};
use k256::Scalar;
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Serialize)]
pub struct CorPositiveEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    pub expected_result: bool,
}

#[derive(Serialize)]
pub struct CorPositiveFixture {
    pub description: &'static str,
    pub entries: Vec<CorPositiveEntry>,
}

#[derive(Serialize)]
pub struct CorRejectEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct CorRejectFixture {
    pub description: &'static str,
    pub entries: Vec<CorRejectEntry>,
}

#[derive(Serialize)]
pub struct CorMutationEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub mutated_signature_hex: String,
    pub flip_offset: usize,
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct CorMutationFixture {
    pub description: &'static str,
    pub baseline_signature_hex: String,
    pub entries: Vec<CorMutationEntry>,
}

/// A child's role in the Cor tree.
enum CorChild {
    /// Simulated: we picked c and z; commitment is derived backward.
    Simulated {
        sb: SigmaBoolean,
        c: [u8; SOUNDNESS_BYTES],
        z: Scalar,
    },
    /// Real: we know the secret; nonce r is fixed.
    Real {
        sb: SigmaBoolean,
        w: Scalar,
        r: Scalar,
    },
}

impl CorChild {
    fn sb(&self) -> &SigmaBoolean {
        match self {
            CorChild::Simulated { sb, .. } | CorChild::Real { sb, .. } => sb,
        }
    }
}

/// Build a deterministic simulated Cor child for a ProveDlog (we construct a
/// pk WITHOUT knowing its secret — though for fixture-gen we always pick the
/// secret and just don't use it for signing; this still produces a valid pk).
fn cor_simulated_dlog(seed: u8, tag: &[u8], msg: &[u8]) -> Result<CorChild> {
    let secret = dlog_secret_scalar(b"ergots-fixture/cor-sim-secret", seed);
    let sb = dlog_sb_from_secret(secret);
    let c = fiat_shamir_hash(&{
        let mut buf = tag.to_vec();
        buf.push(seed);
        buf.extend_from_slice(msg);
        buf
    });
    let z = scalar_from_seed(
        b"ergots-fixture/cor-sim-z",
        &{
            let mut buf = tag.to_vec();
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    Ok(CorChild::Simulated { sb, c, z })
}

fn cor_simulated_dht(seed: u8, tag: &[u8], msg: &[u8]) -> Result<CorChild> {
    let w = scalar_from_seed(b"ergots-fixture/cor-sim-dht-w", &[seed; 32]);
    let h_secret =
        scalar_from_seed(b"ergots-fixture/cor-sim-dht-h", &[seed.wrapping_add(0x80); 32]);
    let sb = dht_sb_from_secret(w, h_secret);
    let c = fiat_shamir_hash(&{
        let mut buf = tag.to_vec();
        buf.push(seed);
        buf.extend_from_slice(msg);
        buf
    });
    let z = scalar_from_seed(
        b"ergots-fixture/cor-sim-dht-z",
        &{
            let mut buf = tag.to_vec();
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    Ok(CorChild::Simulated { sb, c, z })
}

fn cor_real_dlog(seed: u8, tag: &[u8], msg: &[u8]) -> Result<CorChild> {
    let w = dlog_secret_scalar(tag, seed);
    let sb = dlog_sb_from_secret(w);
    let r = scalar_from_seed(
        b"ergots-fixture/cor-real-nonce",
        &{
            let mut buf = w.to_bytes().to_vec();
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    Ok(CorChild::Real { sb, w, r })
}

fn cor_real_dht(seed: u8, tag: &[u8], msg: &[u8]) -> Result<CorChild> {
    let w = scalar_from_seed(tag, &[seed; 32]);
    let h_secret = scalar_from_seed(b"ergots-fixture/cor-real-dht-h", &[seed.wrapping_add(0x80); 32]);
    let sb = dht_sb_from_secret(w, h_secret);
    let r = scalar_from_seed(
        b"ergots-fixture/cor-real-dht-nonce",
        &{
            let mut buf = w.to_bytes().to_vec();
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    Ok(CorChild::Real { sb, w, r })
}

/// Compute the commitment for a Cor child (forward for real, backward for sim).
fn child_commitment(child: &CorChild) -> Result<LeafCommitment> {
    match child {
        CorChild::Simulated { sb, c, z } => match sb {
            SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pk)) => {
                let a = dlog_simulate(pk, c, *z);
                Ok(LeafCommitment::Dlog { a })
            }
            SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(pk)) => {
                let (a, b) = dht_simulate(pk, c, *z);
                Ok(LeafCommitment::Dht { a, b })
            }
            _ => anyhow::bail!("cor child must be a leaf proposition (got conjecture/trivial)"),
        },
        CorChild::Real { sb, r, .. } => match sb {
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
            _ => anyhow::bail!("cor real child must be a leaf proposition"),
        },
    }
}

/// Sign a flat Cor (real-LAST convention). Returns the signature bytes.
fn sign_flat_cor(children: &[CorChild], msg: &[u8]) -> Result<(SigmaBoolean, Vec<u8>)> {
    // Tree shape.
    let items: Vec<SigmaBoolean> = children.iter().map(|c| c.sb().clone()).collect();
    let sb = make_cor(items)?;

    // Commitments per leaf in pre-order.
    let commitments: Vec<LeafCommitment> =
        children.iter().map(child_commitment).collect::<Result<_>>()?;

    // Root challenge.
    let root = root_challenge(&sb, &commitments, msg)?;

    // Last child's challenge = root XOR all sim challenges.
    let n = children.len();
    anyhow::ensure!(n >= 2, "Cor needs at least 2 children");
    let last = &children[n - 1];
    let CorChild::Real { w, r, .. } = last else {
        anyhow::bail!("sign_flat_cor: last child must be Real");
    };
    let mut last_c = root;
    for c in &children[..n - 1] {
        let CorChild::Simulated { c: sim_c, .. } = c else {
            anyhow::bail!("sign_flat_cor: all-but-last children must be Simulated");
        };
        last_c = xor_challenge(&last_c, sim_c);
    }
    // z_last = r + last_c * w.
    let last_z = match last {
        CorChild::Real { sb, w, r } => match sb {
            SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(_)) => {
                dlog_real_z(*r, *w, &last_c)
            }
            SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(_)) => {
                dht_real_z(*r, *w, &last_c)
            }
            _ => anyhow::bail!("unsupported leaf"),
        },
        _ => anyhow::bail!("unreachable"),
    };
    let _ = (w, r); // silence unused-var lint for the outer let binding

    // Serialize.
    let mut sig = Vec::new();
    sig.extend_from_slice(&root);
    for c in &children[..n - 1] {
        let CorChild::Simulated { c: sim_c, z, .. } = c else {
            unreachable!()
        };
        sig.extend_from_slice(sim_c);
        sig.extend_from_slice(&scalar_to_bytes(z));
    }
    sig.extend_from_slice(&scalar_to_bytes(&last_z));

    cross_check_with_sigma_rust(&sb, msg, &sig, "sign_flat_cor")?;
    Ok((sb, sig))
}

// ────────────────────────────────────────────────────────────────────
// Positive entries.
// ────────────────────────────────────────────────────────────────────

fn entry_cor_n_dlog(name: &str, n: usize, seed_base: u8, msg: &[u8]) -> Result<CorPositiveEntry> {
    let mut children = Vec::new();
    for i in 0..(n - 1) {
        children.push(cor_simulated_dlog(
            seed_base.wrapping_add(i as u8),
            b"ergots-fixture/cor-sim-tag",
            msg,
        )?);
    }
    children.push(cor_real_dlog(
        seed_base.wrapping_add(99),
        b"ergots-fixture/cor-real-tag",
        msg,
    )?);
    let (sb, sig) = sign_flat_cor(&children, msg)?;
    Ok(CorPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

fn entry_cor_mixed(name: &str, seed_base: u8, msg: &[u8]) -> Result<CorPositiveEntry> {
    let mut children = Vec::new();
    // 2 simulated dlogs, 1 simulated dht, then 1 real dlog at the end.
    children.push(cor_simulated_dlog(
        seed_base,
        b"ergots-fixture/cor-mix-sim1",
        msg,
    )?);
    children.push(cor_simulated_dht(
        seed_base.wrapping_add(1),
        b"ergots-fixture/cor-mix-sim2",
        msg,
    )?);
    children.push(cor_real_dlog(
        seed_base.wrapping_add(2),
        b"ergots-fixture/cor-mix-real",
        msg,
    )?);
    let (sb, sig) = sign_flat_cor(&children, msg)?;
    Ok(CorPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

fn entry_cor_real_dht_last(name: &str, seed_base: u8, msg: &[u8]) -> Result<CorPositiveEntry> {
    let mut children = Vec::new();
    children.push(cor_simulated_dlog(
        seed_base,
        b"ergots-fixture/cor-dht-last-sim",
        msg,
    )?);
    children.push(cor_real_dht(
        seed_base.wrapping_add(1),
        b"ergots-fixture/cor-dht-last-real",
        msg,
    )?);
    let (sb, sig) = sign_flat_cor(&children, msg)?;
    Ok(CorPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

pub fn generate() -> Result<CorPositiveFixture> {
    let mut entries = Vec::new();

    entries.push(entry_cor_n_dlog("cor-2-dlog-empty-msg", 2, 1, b"")?);
    entries.push(entry_cor_n_dlog("cor-2-dlog-msg-abc", 2, 5, b"abc")?);
    entries.push(entry_cor_n_dlog("cor-3-dlog", 3, 10, b"three-dlog-cor")?);
    entries.push(entry_cor_n_dlog("cor-4-dlog", 4, 20, b"four")?);
    entries.push(entry_cor_n_dlog("cor-5-dlog", 5, 30, b"five-dlog-cor-msg")?);
    entries.push(entry_cor_mixed("cor-mixed-sim-dlog-sim-dht-real-dlog", 40, b"mixed-cor")?);
    entries.push(entry_cor_real_dht_last("cor-real-dht-last", 50, b"dht-last")?);

    Ok(CorPositiveFixture {
        description: "Cor conjecture positive fixtures (phase 2g-combinators Task 8). \
            Real leaf is LAST. Signature layout: root (24) || sim_0_c (24) || sim_0_z (32) || \
            ... || sim_{n-2}_c (24) || sim_{n-2}_z (32) || last_real_z (32). Last child's \
            challenge is derived by verifier via XOR. Includes flat 2/3/4/5-leaf cases, \
            mixed simulated dlog+dht, and real-DH-tuple-last. Each cross-validated against \
            sigma-rust's verify_signature.",
        entries,
    })
}

// ────────────────────────────────────────────────────────────────────
// Baseline + reject + mutation.
// ────────────────────────────────────────────────────────────────────

pub fn baseline_cor_2_dlog() -> Result<(SigmaBoolean, Vec<u8>, Vec<u8>)> {
    let msg: Vec<u8> = b"baseline-cor".to_vec();
    let sim = cor_simulated_dlog(0x42, b"ergots-fixture/cor-baseline-sim", &msg)?;
    let real = cor_real_dlog(0x43, b"ergots-fixture/cor-baseline-real", &msg)?;
    let (sb, sig) = sign_flat_cor(&[sim, real], &msg)?;
    Ok((sb, msg, sig))
}

pub fn generate_reject() -> Result<CorRejectFixture> {
    let mut entries = Vec::new();
    let (sb, msg, sig) = baseline_cor_2_dlog()?;
    // Cor-2-dlog: root (24) || sim_c (24) || sim_z (32) || last_z (32) = 112 bytes.
    debug_assert_eq!(sig.len(), 112, "Cor-2-dlog sig should be 112 bytes");

    // 1. Truncated.
    entries.push(CorRejectEntry {
        name: "cor-truncated-sig".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: hex::encode(&sig[..40]),
        expected_outcome: "truncated-signature".to_string(),
    });

    // 2. Empty.
    entries.push(CorRejectEntry {
        name: "cor-empty-sig".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: String::new(),
        expected_outcome: "empty-signature".to_string(),
    });

    // 3. Wrong-but-valid-shaped: flip the root challenge bit but keep length.
    //    More structural: just zero out the simulated child's challenge bytes.
    let mut bad = sig.clone();
    for byte in &mut bad[24..48] {
        *byte = 0;
    }
    entries.push(CorRejectEntry {
        name: "cor-zeroed-sim-challenge".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: hex::encode(&bad),
        expected_outcome: "returns-false".to_string(),
    });

    Ok(CorRejectFixture {
        description: "Cor reject fixtures: truncated, empty, zeroed-sim-challenge \
            variants of a baseline Cor-2-dlog. Verifier must reject (error or false).",
        entries,
    })
}

pub fn generate_mutation() -> Result<CorMutationFixture> {
    let (sb, msg, sig) = baseline_cor_2_dlog()?;
    let sig_len = sig.len();
    debug_assert_eq!(sig_len, 112);

    let mut entries = Vec::with_capacity(sig_len);
    for offset in 0..sig_len {
        let mut mutated = sig.clone();
        mutated[offset] ^= 0xff;
        entries.push(CorMutationEntry {
            name: format!("cor-flip-byte-{:03}", offset),
            sigma_boolean_json: sigma_boolean_to_json(&sb),
            message_hex: hex::encode(&msg),
            mutated_signature_hex: hex::encode(&mutated),
            flip_offset: offset,
            expected_outcome: "false-or-error".to_string(),
        });
    }

    Ok(CorMutationFixture {
        description: "Cor byte-flip mutation fixtures: 112 single-byte-flip mutations of \
            a baseline Cor-2-dlog signature. The verifier must return false or throw \
            VerifyError on every entry.",
        baseline_signature_hex: hex::encode(&sig),
        entries,
    })
}
