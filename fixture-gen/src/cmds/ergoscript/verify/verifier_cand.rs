//! Cand conjecture verifier fixtures (phase 2g-combinators Task 8).
//!
//! Recipe (all-leaves Cand):
//!   1. For each leaf (real, since Cand requires all witnesses): pick a
//!      deterministic nonce r_i. Compute commitment a_i = g^{r_i}
//!      (or (a_i, b_i) for DH-tuple). All leaves are "real" for Cand.
//!   2. Build Fiat-Shamir input: tree-encoded(sb, [a_i bytes per leaf]) || msg.
//!      Hash with blake2b256 → first 24 bytes = root_challenge.
//!   3. For each leaf: c_i = root_challenge (all children share it for Cand).
//!      z_i = r_i + c_i * w_i.
//!   4. Serialize: root_challenge (24) || z_1 (32) || z_2 (32) || ... || z_n (32).
//!      Per `sig_serializer.rs:69-78`: children's challenges are NOT written.
//!   5. Cross-validate: sigma-rust's `verify_signature` must return true.
//!
//! Nested-conjecture cases (Cand containing a Cor sub-tree) recurse the
//! signing pattern: at the Cor sub-tree, run the Cor recipe with the
//! INHERITED challenge as if it were the Cor's "root", but DON'T write the
//! Cor's own challenge into the proof bytes (it's the same as parent's).
//!
//! Source:
//!   ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:69-78 (writer)
//!   ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:175-186 (verifier)
//!   ergotree-interpreter/src/sigma_protocol/prover.rs:799-815 (step9_real_and)

use crate::cmds::ergoscript::verify::verifier_conj_common::{
    cross_check_with_sigma_rust, dht_real_z, dht_sb_from_secret, dlog_real_z, dlog_sb_from_secret,
    dlog_secret_scalar, dlog_simulate, fiat_shamir_hash, make_cand, make_cor, root_challenge,
    scalar_from_seed, scalar_to_bytes, xor_challenge, LeafCommitment, SOUNDNESS_BYTES,
};
use crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json;
use anyhow::Result;
use ergo_chain_types::ec_point::{exponentiate, exponentiate_gen};
use ergotree_ir::sigma_protocol::sigma_boolean::{
    SigmaBoolean, SigmaConjecture, SigmaProofOfKnowledgeTree,
};
use k256::Scalar;
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Serialize)]
pub struct CandPositiveEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    pub expected_result: bool,
}

#[derive(Serialize)]
pub struct CandPositiveFixture {
    pub description: &'static str,
    pub entries: Vec<CandPositiveEntry>,
}

#[derive(Serialize)]
pub struct CandRejectEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    /// One of: 'returns-false' (well-formed but wrong) or a typed error code.
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct CandRejectFixture {
    pub description: &'static str,
    pub entries: Vec<CandRejectEntry>,
}

#[derive(Serialize)]
pub struct CandMutationEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub mutated_signature_hex: String,
    pub flip_offset: usize,
    /// Always 'false-or-error'.
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct CandMutationFixture {
    pub description: &'static str,
    pub baseline_signature_hex: String,
    pub entries: Vec<CandMutationEntry>,
}

// ────────────────────────────────────────────────────────────────────
// Secret-and-tree builders (parallel trees of SigmaBooleans / secrets).
// ────────────────────────────────────────────────────────────────────

/// A leaf's witness: secret w (and h_secret for DH-tuple), plus a nonce r.
#[derive(Clone)]
enum LeafWitness {
    Dlog { w: Scalar, r: Scalar },
    Dht { w: Scalar, r: Scalar },
}

/// Walk the SigmaBoolean tree in pre-order, collecting commitments for each
/// leaf (real Cand path): for ProveDlog, a = g^r; for ProveDhTuple, (a, b) = (g^r, h^r).
fn collect_commitments(sb: &SigmaBoolean, witnesses: &[LeafWitness]) -> Result<Vec<LeafCommitment>> {
    let mut out = Vec::new();
    let mut wit_slice: &[LeafWitness] = witnesses;
    collect_commitments_inner(sb, &mut wit_slice, &mut out)?;
    anyhow::ensure!(
        wit_slice.is_empty(),
        "collect_commitments: leftover witnesses — tree shape vs. witness count mismatch"
    );
    Ok(out)
}

fn collect_commitments_inner(
    sb: &SigmaBoolean,
    witnesses: &mut &[LeafWitness],
    out: &mut Vec<LeafCommitment>,
) -> Result<()> {
    match sb {
        SigmaBoolean::TrivialProp(_) => {
            anyhow::bail!("Cand fixture builder: TrivialProp not supported")
        }
        SigmaBoolean::ProofOfKnowledge(pk) => {
            let wit = witnesses
                .first()
                .ok_or_else(|| anyhow::anyhow!("collect_commitments: ran out of witnesses"))?;
            *witnesses = &witnesses[1..];
            match (pk, wit) {
                (SigmaProofOfKnowledgeTree::ProveDlog(_), LeafWitness::Dlog { r, .. }) => {
                    let a = exponentiate_gen(r);
                    out.push(LeafCommitment::Dlog { a });
                }
                (SigmaProofOfKnowledgeTree::ProveDhTuple(p), LeafWitness::Dht { r, .. }) => {
                    let a = exponentiate(&p.g, r);
                    let b = exponentiate(&p.h, r);
                    out.push(LeafCommitment::Dht { a, b });
                }
                _ => anyhow::bail!("collect_commitments: leaf-type mismatch with witness type"),
            }
            Ok(())
        }
        SigmaBoolean::SigmaConjecture(c) => match c {
            SigmaConjecture::Cand(a) => {
                for child in a.items.iter() {
                    collect_commitments_inner(child, witnesses, out)?;
                }
                Ok(())
            }
            SigmaConjecture::Cor(_) | SigmaConjecture::Cthreshold(_) => anyhow::bail!(
                "Cand all-real builder: nested Cor/Cthreshold needs simulated children — \
                 use the nested-conjecture helpers instead"
            ),
        },
    }
}

/// Walk the SigmaBoolean tree in pre-order, writing z bytes per leaf.
/// The challenge for each leaf is `inherited_challenge` (Cand semantics:
/// all children inherit the parent's challenge).
fn write_z_for_cand(
    sb: &SigmaBoolean,
    witnesses: &mut &[LeafWitness],
    inherited_challenge: &[u8; SOUNDNESS_BYTES],
    out: &mut Vec<u8>,
) -> Result<()> {
    match sb {
        SigmaBoolean::TrivialProp(_) => anyhow::bail!("write_z_for_cand: TrivialProp not supported"),
        SigmaBoolean::ProofOfKnowledge(_) => {
            let wit = witnesses
                .first()
                .ok_or_else(|| anyhow::anyhow!("write_z_for_cand: ran out of witnesses"))?
                .clone();
            *witnesses = &witnesses[1..];
            let z = match wit {
                LeafWitness::Dlog { w, r } => dlog_real_z(r, w, inherited_challenge),
                LeafWitness::Dht { w, r } => dht_real_z(r, w, inherited_challenge),
            };
            out.extend_from_slice(&scalar_to_bytes(&z));
            Ok(())
        }
        SigmaBoolean::SigmaConjecture(c) => match c {
            SigmaConjecture::Cand(a) => {
                for child in a.items.iter() {
                    write_z_for_cand(child, witnesses, inherited_challenge, out)?;
                }
                Ok(())
            }
            SigmaConjecture::Cor(_) | SigmaConjecture::Cthreshold(_) => anyhow::bail!(
                "write_z_for_cand: nested Cor/Cthreshold not in this code path"
            ),
        },
    }
}

/// Sign a flat Cand tree (all leaves real). Returns the full signature bytes.
fn sign_flat_cand(sb: &SigmaBoolean, witnesses: &[LeafWitness], msg: &[u8]) -> Result<Vec<u8>> {
    let commitments = collect_commitments(sb, witnesses)?;
    let root = root_challenge(sb, &commitments, msg)?;

    let mut sig = Vec::new();
    sig.extend_from_slice(&root);
    let mut wit_slice: &[LeafWitness] = witnesses;
    write_z_for_cand(sb, &mut wit_slice, &root, &mut sig)?;
    anyhow::ensure!(
        wit_slice.is_empty(),
        "sign_flat_cand: leftover witnesses — fixture-gen bug"
    );
    Ok(sig)
}

// ────────────────────────────────────────────────────────────────────
// Fixture entry builders.
// ────────────────────────────────────────────────────────────────────

fn make_dlog_witness(tag: &[u8], seed: u8, msg: &[u8]) -> (SigmaBoolean, LeafWitness, Scalar) {
    let w = dlog_secret_scalar(tag, seed);
    let sb = dlog_sb_from_secret(w);
    let r = scalar_from_seed(
        b"ergots-fixture/conj-nonce",
        &{
            let mut buf = Vec::with_capacity(32 + 1 + msg.len());
            buf.extend_from_slice(&w.to_bytes());
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    let wit = LeafWitness::Dlog { w, r };
    (sb, wit, w)
}

fn make_dht_witness(tag: &[u8], seed: u8, msg: &[u8]) -> (SigmaBoolean, LeafWitness) {
    let w = scalar_from_seed(tag, &[seed; 32]);
    let h_secret = scalar_from_seed(b"ergots-fixture/conj-dht-h", &[seed.wrapping_add(0x80); 32]);
    let sb = dht_sb_from_secret(w, h_secret);
    let r = scalar_from_seed(
        b"ergots-fixture/conj-nonce-dht",
        &{
            let mut buf = Vec::with_capacity(32 + 1 + msg.len());
            buf.extend_from_slice(&w.to_bytes());
            buf.push(seed);
            buf.extend_from_slice(msg);
            buf
        },
    );
    let wit = LeafWitness::Dht { w, r };
    (sb, wit)
}

fn entry_cand_n_dlog(name: &str, n: usize, seed_base: u8, msg: &[u8]) -> Result<CandPositiveEntry> {
    let mut leaves = Vec::new();
    let mut witnesses = Vec::new();
    for i in 0..n {
        let (sb, wit, _) = make_dlog_witness(
            b"ergots-fixture/cand-dlog",
            seed_base.wrapping_add(i as u8),
            msg,
        );
        leaves.push(sb);
        witnesses.push(wit);
    }
    let sb = make_cand(leaves)?;
    let sig = sign_flat_cand(&sb, &witnesses, msg)?;
    cross_check_with_sigma_rust(&sb, msg, &sig, name)?;
    Ok(CandPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

fn entry_cand_mixed_dlog_dht(name: &str, seed_base: u8, msg: &[u8]) -> Result<CandPositiveEntry> {
    let (sb1, wit1, _) = make_dlog_witness(
        b"ergots-fixture/cand-mix-dlog",
        seed_base,
        msg,
    );
    let (sb2, wit2) = make_dht_witness(
        b"ergots-fixture/cand-mix-dht",
        seed_base.wrapping_add(1),
        msg,
    );
    let sb = make_cand(vec![sb1, sb2])?;
    let sig = sign_flat_cand(&sb, &[wit1, wit2], msg)?;
    cross_check_with_sigma_rust(&sb, msg, &sig, name)?;
    Ok(CandPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

/// Build a nested Cand-of-Cands: Cand(dlog1, Cand(dlog2, dlog3)).
/// All leaves real → all leaves inherit the root challenge regardless of nesting.
fn entry_cand_nested_cand(name: &str, seed_base: u8, msg: &[u8]) -> Result<CandPositiveEntry> {
    let (sb1, wit1, _) = make_dlog_witness(b"ergots-fixture/cand-nest-1", seed_base, msg);
    let (sb2, wit2, _) = make_dlog_witness(
        b"ergots-fixture/cand-nest-2",
        seed_base.wrapping_add(1),
        msg,
    );
    let (sb3, wit3, _) = make_dlog_witness(
        b"ergots-fixture/cand-nest-3",
        seed_base.wrapping_add(2),
        msg,
    );
    let inner = make_cand(vec![sb2, sb3])?;
    let sb = make_cand(vec![sb1, inner])?;
    let sig = sign_flat_cand(&sb, &[wit1, wit2, wit3], msg)?;
    cross_check_with_sigma_rust(&sb, msg, &sig, name)?;
    Ok(CandPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

/// Sign a tree that is Cand(real_leaf, Cor(sim_leaf, real_leaf)).
/// The Cor sub-tree's "root" challenge is INHERITED from parent Cand
/// (so it's the SAME as Cand's root challenge), and the Cor's last child
/// gets challenge = inherited XOR sim_child_challenge.
///
/// This is the only case where we need to combine recipes. The structure:
///   - sb_cand = Cand(sb_real_dlog, sb_cor)
///   - sb_cor  = Cor(sb_sim_dlog, sb_real_dlog_cor)
///   - witnesses for both REAL leaves (sb_real_dlog, sb_real_dlog_cor) +
///     a simulated entry (challenge, z) for the Cor's first child.
fn entry_cand_with_nested_cor(
    name: &str,
    seed_base: u8,
    msg: &[u8],
) -> Result<CandPositiveEntry> {
    // Outer Cand leaf 0: a real ProveDlog.
    let (sb_a, wit_a, _) = make_dlog_witness(
        b"ergots-fixture/cand-nest-cor-a",
        seed_base,
        msg,
    );

    // Cor sub-tree:
    //   child 0 = simulated ProveDlog (we know NO secret for this one).
    //   child 1 = real ProveDlog at LAST position (verifier's XOR-derive target).
    // Simulated pk: derive a fresh `secret` to construct pk, but DON'T sign with it.
    let sim_secret = dlog_secret_scalar(b"ergots-fixture/cand-cor-sim", seed_base.wrapping_add(10));
    let sb_sim = dlog_sb_from_secret(sim_secret);
    let (sb_real_cor, wit_real_cor, _) = make_dlog_witness(
        b"ergots-fixture/cand-cor-real",
        seed_base.wrapping_add(20),
        msg,
    );

    // Pick simulated (c, z) for child 0 deterministically.
    let sim_c_bytes = fiat_shamir_hash(&{
        let mut buf = b"ergots-fixture/cand-cor-sim-c".to_vec();
        buf.push(seed_base);
        buf.extend_from_slice(msg);
        buf
    });
    let sim_z = scalar_from_seed(
        b"ergots-fixture/cand-cor-sim-z",
        &{
            let mut buf = vec![seed_base];
            buf.extend_from_slice(msg);
            buf
        },
    );
    let sim_a = if let SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pk)) =
        &sb_sim
    {
        dlog_simulate(pk, &sim_c_bytes, sim_z)
    } else {
        anyhow::bail!("expected ProveDlog leaf for sim");
    };

    // Real Cor last-child: pick nonce r → a = g^r.
    let r_real_cor = if let LeafWitness::Dlog { r, .. } = &wit_real_cor {
        *r
    } else {
        anyhow::bail!("expected Dlog witness for cor real");
    };
    let real_cor_a = exponentiate_gen(&r_real_cor);

    let sb_cor = make_cor(vec![sb_sim.clone(), sb_real_cor.clone()])?;
    let sb = make_cand(vec![sb_a.clone(), sb_cor])?;

    // Commitments in pre-order: [sb_a commitment, sb_sim commitment, sb_real_cor commitment]
    let cmt_a = match &wit_a {
        LeafWitness::Dlog { r, .. } => LeafCommitment::Dlog {
            a: exponentiate_gen(r),
        },
        _ => anyhow::bail!("wit_a should be Dlog"),
    };
    let commitments = vec![
        cmt_a,
        LeafCommitment::Dlog { a: sim_a },
        LeafCommitment::Dlog { a: real_cor_a },
    ];

    // Root challenge = FS(tree || msg).
    let root = root_challenge(&sb, &commitments, msg)?;

    // Cor's challenge (inherited from parent Cand) = root.
    // Cor's last child's challenge = inherited XOR sim_c.
    let real_cor_c = xor_challenge(&root, &sim_c_bytes);

    // Compute z values.
    // sb_a (Cand leaf 0): z_a = r_a + root * w_a.
    let z_a = if let LeafWitness::Dlog { w, r } = &wit_a {
        dlog_real_z(*r, *w, &root)
    } else {
        anyhow::bail!("wit_a Dlog");
    };
    let z_real_cor = if let LeafWitness::Dlog { w, r } = &wit_real_cor {
        dlog_real_z(*r, *w, &real_cor_c)
    } else {
        anyhow::bail!("wit_real_cor Dlog");
    };

    // Signature layout for Cand(leaf_a, Cor(sim, real)):
    //   root_challenge (24)
    //   [Cand children, no explicit challenges per sig_serializer.rs:69-78]
    //     leaf_a: z_a (32)
    //     Cor: [no own challenge since inherited from Cand]
    //       sim_child_challenge (24) || sim_z (32)
    //       [last child: no challenge written, just z]
    //       real_cor_z (32)
    let mut sig = Vec::new();
    sig.extend_from_slice(&root);
    sig.extend_from_slice(&scalar_to_bytes(&z_a));
    sig.extend_from_slice(&sim_c_bytes);
    sig.extend_from_slice(&scalar_to_bytes(&sim_z));
    sig.extend_from_slice(&scalar_to_bytes(&z_real_cor));

    cross_check_with_sigma_rust(&sb, msg, &sig, name)?;
    Ok(CandPositiveEntry {
        name: name.to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(msg),
        signature_hex: hex::encode(&sig),
        expected_result: true,
    })
}

// ────────────────────────────────────────────────────────────────────
// Generators.
// ────────────────────────────────────────────────────────────────────

pub fn generate() -> Result<CandPositiveFixture> {
    let mut entries = Vec::new();

    entries.push(entry_cand_n_dlog("cand-2-dlog-empty-msg", 2, 1, b"")?);
    entries.push(entry_cand_n_dlog("cand-2-dlog-msg-abc", 2, 3, b"abc")?);
    entries.push(entry_cand_n_dlog("cand-3-dlog", 3, 10, b"three-dlog")?);
    entries.push(entry_cand_n_dlog("cand-5-dlog", 5, 20, b"five-dlog-long-message")?);
    entries.push(entry_cand_mixed_dlog_dht("cand-mixed-dlog-dht", 30, b"mixed")?);
    entries.push(entry_cand_nested_cand("cand-nested-cand-of-cand", 40, b"")?);
    entries.push(entry_cand_with_nested_cor(
        "cand-with-nested-cor-mixed-real-sim",
        50,
        b"nested-cor-inside-cand",
    )?);

    Ok(CandPositiveFixture {
        description: "Cand conjecture positive fixtures (phase 2g-combinators Task 8). \
            Cand-all-real recipe: every leaf shares root_challenge; signature is \
            root (24) || z_1 (32) || ... || z_n (32). Includes flat 2/3/5-leaf cases, \
            mixed dlog+dht, nested Cand-of-Cand, and a Cand-with-nested-Cor (Cor's \
            challenge is inherited from parent Cand). Each fixture is cross-validated \
            against sigma-rust's verify_signature before write.",
        entries,
    })
}

// ────────────────────────────────────────────────────────────────────
// Reject + mutation generators.
// ────────────────────────────────────────────────────────────────────

/// Build a baseline 2-dlog Cand triple. Used by reject + mutation.
pub fn baseline_cand_2_dlog() -> Result<(SigmaBoolean, Vec<u8>, Vec<u8>)> {
    let (sb1, wit1, _) = make_dlog_witness(b"ergots-fixture/cand-baseline-1", 0x42, b"baseline");
    let (sb2, wit2, _) = make_dlog_witness(b"ergots-fixture/cand-baseline-2", 0x43, b"baseline");
    let sb = make_cand(vec![sb1, sb2])?;
    let msg: Vec<u8> = b"baseline".to_vec();
    let sig = sign_flat_cand(&sb, &[wit1, wit2], &msg)?;
    cross_check_with_sigma_rust(&sb, &msg, &sig, "baseline_cand_2_dlog")?;
    Ok((sb, msg, sig))
}

pub fn generate_reject() -> Result<CandRejectFixture> {
    let mut entries = Vec::new();
    let (sb, msg, sig) = baseline_cand_2_dlog()?;

    // 1. Truncated signature.
    entries.push(CandRejectEntry {
        name: "cand-truncated-sig".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: hex::encode(&sig[..10]),
        expected_outcome: "truncated-signature".to_string(),
    });

    // 2. Empty signature.
    entries.push(CandRejectEntry {
        name: "cand-empty-sig".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: String::new(),
        expected_outcome: "empty-signature".to_string(),
    });

    // 3. Wrong-but-valid-shaped signature: swap z_1 and z_2 → root_challenge mismatch.
    let mut swapped = sig.clone();
    let n = sig.len();
    debug_assert_eq!(n, 88, "baseline Cand-2-dlog sig must be 88 bytes");
    // sig = root(24) || z1(32) || z2(32). Swap the two z blocks.
    swapped[24..56].copy_from_slice(&sig[56..88]);
    swapped[56..88].copy_from_slice(&sig[24..56]);
    entries.push(CandRejectEntry {
        name: "cand-swapped-z-values".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&sb),
        message_hex: hex::encode(&msg),
        signature_hex: hex::encode(&swapped),
        expected_outcome: "returns-false".to_string(),
    });

    Ok(CandRejectFixture {
        description: "Cand reject fixtures: malformed (truncated, empty) and wrong-but-\
            valid-shaped (swapped z) Cand-2-dlog signatures. The verifier must reject \
            each one (either by typed error or by returning false).",
        entries,
    })
}

pub fn generate_mutation() -> Result<CandMutationFixture> {
    let (sb, msg, sig) = baseline_cand_2_dlog()?;
    let sig_len = sig.len();
    debug_assert_eq!(sig_len, 88, "baseline Cand-2-dlog sig must be 88 bytes");

    let mut entries = Vec::with_capacity(sig_len);
    for offset in 0..sig_len {
        let mut mutated = sig.clone();
        mutated[offset] ^= 0xff;
        // sig = root_challenge (24) || z1 (32) || z2 (32).
        let region = if offset < 24 { "root-challenge" } else { "scalar-z" };
        entries.push(CandMutationEntry {
            name: format!("cand-flip-byte-{:02}-{}", offset, region),
            sigma_boolean_json: sigma_boolean_to_json(&sb),
            message_hex: hex::encode(&msg),
            mutated_signature_hex: hex::encode(&mutated),
            flip_offset: offset,
            expected_outcome: "false-or-error".to_string(),
        });
    }

    Ok(CandMutationFixture {
        description: "Cand byte-flip mutation fixtures: 88 single-byte mutations of a \
            baseline Cand-2-dlog signature. Regions: root-challenge (0-23), scalar-z \
            (24-87). The verifier must return false or throw VerifyError on every entry; \
            returning true is a vulnerability.",
        baseline_signature_hex: hex::encode(&sig),
        entries,
    })
}
