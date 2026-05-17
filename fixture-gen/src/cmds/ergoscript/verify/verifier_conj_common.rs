//! Shared helpers for conjecture-signing fixture-gen (phase 2g-combinators Task 8).
//!
//! Extends the leaf-only manual deterministic signing pattern in
//! `verifier_positive.rs` to Cand/Cor/Cthreshold conjecture trees.
//!
//! The verifier's correctness equation (`verifier.rs:107-117`) is:
//!
//!   1. parse_sig_compute_challenges → for each leaf, read z; recover its
//!      challenge from the proof bytes (root_challenge for Cand children,
//!      explicit per-leaf challenges for Cor's non-last children, etc.).
//!   2. compute_commitments → for each leaf, recover its commitment a from
//!      (pk, challenge, z) via the verifier equation `a = g^z * inverse(pk^e)`.
//!   3. fiat_shamir_tree_to_bytes(tree_with_a_filled_in) || message → hash with
//!      blake2b-256, take first 24 bytes → expected_challenge.
//!   4. accept iff root.challenge == expected_challenge.
//!
//! To produce a signature that satisfies this, fixture-gen picks all leaf
//! commitments first (using real-nonce or backward-simulator commitments),
//! then computes root_challenge = FS(tree_with_commitments || msg), then
//! solves backward for the z values that the verifier will recover.
//!
//! Source:
//!   ergotree-interpreter/src/sigma_protocol/sig_serializer.rs
//!   ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs
//!   ergotree-interpreter/src/sigma_protocol/verifier.rs

use anyhow::Result;
use ergo_chain_types::ec_point::{exponentiate, exponentiate_gen, generator, inverse};
use ergo_chain_types::EcPoint;
use ergotree_interpreter::sigma_protocol::verifier::verify_signature;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::cand::Cand;
use ergotree_ir::sigma_protocol::sigma_boolean::cor::Cor;
use ergotree_ir::sigma_protocol::sigma_boolean::cthreshold::Cthreshold;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDhTuple, ProveDlog, SigmaBoolean, SigmaConjecture, SigmaConjectureItems,
    SigmaProofOfKnowledgeTree, SigmaProp,
};
use k256::elliptic_curve::ops::Reduce;
use k256::{Scalar, U256};
use sigma_util::hash::blake2b256_hash;

/// Soundness parameter (mirrors `sigma_protocol::SOUNDNESS_BYTES = 192/8`).
pub const SOUNDNESS_BYTES: usize = 24;

/// Group element size (mirrors `sigma_protocol::GROUP_SIZE = 256/8`).
pub const GROUP_SIZE: usize = 32;

/// ConjectureType byte tags written into the Fiat-Shamir tree
/// (mirrors `proof_tree::ConjectureType` discriminants).
pub const CONJ_AND: u8 = 0;
pub const CONJ_OR: u8 = 1;
pub const CONJ_THRESHOLD: u8 = 2;

const INTERNAL_NODE_PREFIX: u8 = 0;
const LEAF_PREFIX: u8 = 1;

// ────────────────────────────────────────────────────────────────────
// Deterministic scalar / nonce derivation (duplicated from
// verifier_positive.rs intentionally so this module is self-contained;
// the originals are private — see SESSION_CONTEXT for why we don't
// expose them).
// ────────────────────────────────────────────────────────────────────

pub fn scalar_from_seed(tag: &[u8], bytes: &[u8]) -> Scalar {
    let mut input = Vec::with_capacity(tag.len() + bytes.len());
    input.extend_from_slice(tag);
    input.extend_from_slice(bytes);
    let hash = blake2b256_hash(&input);
    let arr: [u8; 32] = *hash;
    <Scalar as Reduce<U256>>::reduce_bytes(&arr.into())
}

/// Derive a deterministic 32-byte secret scalar from a tagged seed byte.
pub fn dlog_secret_scalar(tag: &[u8], seed: u8) -> Scalar {
    scalar_from_seed(tag, &[seed; 32])
}

/// Convert a 24-byte challenge to a Scalar via left-pad with 8 zero bytes
/// then reduce mod n. Mirrors `wscalar.rs:69-76 (From<&Challenge> for Scalar)`.
pub fn challenge_to_scalar(challenge: &[u8; SOUNDNESS_BYTES]) -> Scalar {
    let mut padded = [0u8; 32];
    padded[GROUP_SIZE - SOUNDNESS_BYTES..].copy_from_slice(challenge);
    <Scalar as Reduce<U256>>::reduce_bytes(&padded.into())
}

/// Take the first SOUNDNESS_BYTES of blake2b-256.
pub fn fiat_shamir_hash(input: &[u8]) -> [u8; SOUNDNESS_BYTES] {
    let hash = blake2b256_hash(input);
    let mut out = [0u8; SOUNDNESS_BYTES];
    out.copy_from_slice(&hash[..SOUNDNESS_BYTES]);
    out
}

/// 32-byte big-endian scalar.
pub fn scalar_to_bytes(s: &Scalar) -> [u8; 32] {
    s.to_bytes().into()
}

/// XOR two 24-byte challenges.
pub fn xor_challenge(
    a: &[u8; SOUNDNESS_BYTES],
    b: &[u8; SOUNDNESS_BYTES],
) -> [u8; SOUNDNESS_BYTES] {
    let mut out = [0u8; SOUNDNESS_BYTES];
    for i in 0..SOUNDNESS_BYTES {
        out[i] = a[i] ^ b[i];
    }
    out
}

// ────────────────────────────────────────────────────────────────────
// SigmaBoolean factory helpers.
// ────────────────────────────────────────────────────────────────────

pub fn dlog_sb_from_secret(w: Scalar) -> SigmaBoolean {
    let pk = ProveDlog::new(exponentiate_gen(&w));
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(pk))
}

/// Build a deterministic ProveDhTuple from two scalars: `g = G`, `h = G^h_secret`,
/// `u = g^w`, `v = h^w`. Mirrors `DhTupleProverInput::random` recipe.
pub fn dht_sb_from_secret(w: Scalar, h_secret: Scalar) -> SigmaBoolean {
    let g = generator();
    let h = exponentiate_gen(&h_secret);
    let u = exponentiate_gen(&w);
    let v = exponentiate(&h, &w);
    let pk = ProveDhTuple::new(g, h, u, v);
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(pk))
}

// ────────────────────────────────────────────────────────────────────
// Fiat-Shamir tree serialization (replicates `fiat_shamir_write_bytes`
// in fiat_shamir.rs — private in sigma-rust).
// ────────────────────────────────────────────────────────────────────

/// Per-leaf commitment-bytes accessor: for ProveDlog, the bytes of `a`;
/// for ProveDhTuple, the bytes of `a || b`.
#[derive(Clone)]
pub enum LeafCommitment {
    Dlog { a: EcPoint },
    Dht { a: EcPoint, b: EcPoint },
}

impl LeafCommitment {
    pub fn bytes(&self) -> Result<Vec<u8>> {
        match self {
            LeafCommitment::Dlog { a } => Ok(a.sigma_serialize_bytes()?),
            LeafCommitment::Dht { a, b } => {
                let mut out = a.sigma_serialize_bytes()?;
                out.extend_from_slice(&b.sigma_serialize_bytes()?);
                Ok(out)
            }
        }
    }
}

/// Build the propBytes for a leaf — wraps the SigmaBoolean in an
/// `ErgoTree(v0, constSegregation=true)` and serializes. Matches
/// `fiat_shamir_write_bytes` leaf path (`fiat_shamir.rs:148-157`).
pub fn prop_bytes(sb: &SigmaBoolean) -> Result<Vec<u8>> {
    let sigma_prop = SigmaProp::new(sb.clone());
    let constant: ergotree_ir::mir::constant::Constant = sigma_prop.into();
    let body: Expr = constant.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &body)?;
    Ok(tree.sigma_serialize_bytes()?)
}

/// Recursively serialize the conjecture tree for Fiat-Shamir input.
///
/// IMPORTANT: this expects a leaves-flat tree where commitments are
/// supplied via `leaf_commitments` in pre-order. Each call to a leaf
/// pops one commitment from the front of the slice.
fn fs_write_tree(
    sb: &SigmaBoolean,
    leaf_commitments: &mut &[LeafCommitment],
    out: &mut Vec<u8>,
) -> Result<()> {
    match sb {
        SigmaBoolean::TrivialProp(_) => {
            anyhow::bail!("fs_write_tree: TrivialProp not supported in conjecture FS path")
        }
        SigmaBoolean::ProofOfKnowledge(_) => {
            let cmt = leaf_commitments
                .first()
                .ok_or_else(|| anyhow::anyhow!("fs_write_tree: ran out of leaf commitments"))?;
            *leaf_commitments = &leaf_commitments[1..];
            let cmt_bytes = cmt.bytes()?;
            let prop = prop_bytes(sb)?;
            out.push(LEAF_PREFIX);
            let prop_len = i16::try_from(prop.len()).expect("prop fits in i16");
            out.extend_from_slice(&prop_len.to_be_bytes());
            out.extend_from_slice(&prop);
            let cmt_len = i16::try_from(cmt_bytes.len()).expect("commitment fits in i16");
            out.extend_from_slice(&cmt_len.to_be_bytes());
            out.extend_from_slice(&cmt_bytes);
            Ok(())
        }
        SigmaBoolean::SigmaConjecture(c) => match c {
            SigmaConjecture::Cand(a) => {
                out.push(INTERNAL_NODE_PREFIX);
                out.push(CONJ_AND);
                let n = i16::try_from(a.items.len()).expect("children fit in i16");
                out.extend_from_slice(&n.to_be_bytes());
                for child in a.items.iter() {
                    fs_write_tree(child, leaf_commitments, out)?;
                }
                Ok(())
            }
            SigmaConjecture::Cor(o) => {
                out.push(INTERNAL_NODE_PREFIX);
                out.push(CONJ_OR);
                let n = i16::try_from(o.items.len()).expect("children fit in i16");
                out.extend_from_slice(&n.to_be_bytes());
                for child in o.items.iter() {
                    fs_write_tree(child, leaf_commitments, out)?;
                }
                Ok(())
            }
            SigmaConjecture::Cthreshold(t) => {
                out.push(INTERNAL_NODE_PREFIX);
                out.push(CONJ_THRESHOLD);
                out.push(t.k);
                let n = i16::try_from(t.children.len()).expect("children fit in i16");
                out.extend_from_slice(&n.to_be_bytes());
                for child in t.children.iter() {
                    fs_write_tree(child, leaf_commitments, out)?;
                }
                Ok(())
            }
        },
    }
}

/// Compute root_challenge = blake2b256(fs_tree(sb_with_commitments) || msg)[..24].
pub fn root_challenge(
    sb: &SigmaBoolean,
    leaf_commitments: &[LeafCommitment],
    msg: &[u8],
) -> Result<[u8; SOUNDNESS_BYTES]> {
    let mut fs_input = Vec::new();
    let mut commitments_slice: &[LeafCommitment] = leaf_commitments;
    fs_write_tree(sb, &mut commitments_slice, &mut fs_input)?;
    anyhow::ensure!(
        commitments_slice.is_empty(),
        "root_challenge: leftover leaf commitments — leaf count mismatch"
    );
    fs_input.extend_from_slice(msg);
    Ok(fiat_shamir_hash(&fs_input))
}

// ────────────────────────────────────────────────────────────────────
// Leaf signing primitives.
//
// Each "real" leaf-sign returns the response z given the challenge
// the verifier WILL recover (root_challenge for Cand, root XOR for
// Cor's last child, polynomial evaluation for Cthreshold's real ones).
// The commitment is computed by exponentiating the nonce; the leaf's
// challenge is passed in by the caller (it's external to the leaf).
// ────────────────────────────────────────────────────────────────────

/// Real ProveDlog leaf: given nonce r, secret w, challenge c → z = r + c*w.
/// Verifier recovers a = g^z * inverse(pk^c). Cross-check: this `z` should
/// satisfy a == g^r when run through the verifier equation.
pub fn dlog_real_z(r: Scalar, w: Scalar, c: &[u8; SOUNDNESS_BYTES]) -> Scalar {
    let e = challenge_to_scalar(c);
    r + e * w
}

/// Real ProveDhTuple leaf: same z formula (Schnorr-style: z = r + c*w).
/// Verifier recovers a = g^z * inverse(u^c), b = h^z * inverse(v^c).
pub fn dht_real_z(r: Scalar, w: Scalar, c: &[u8; SOUNDNESS_BYTES]) -> Scalar {
    let e = challenge_to_scalar(c);
    r + e * w
}

/// Simulated ProveDlog: given (random) c and z, recover commitment a.
/// Mirrors `dlog_protocol::interactive_prover::simulate`:
///   a = g^z * h^(-c) = g^z * inverse(h^c)
pub fn dlog_simulate(pk: &ProveDlog, c: &[u8; SOUNDNESS_BYTES], z: Scalar) -> EcPoint {
    let e = challenge_to_scalar(c);
    let g_z = exponentiate_gen(&z);
    let h_e = exponentiate(&pk.h, &e);
    g_z * &inverse(&h_e)
}

/// Simulated ProveDhTuple: given c and z, recover (a, b).
///   a = g^z * inverse(u^c), b = h^z * inverse(v^c)
pub fn dht_simulate(
    pk: &ProveDhTuple,
    c: &[u8; SOUNDNESS_BYTES],
    z: Scalar,
) -> (EcPoint, EcPoint) {
    let e = challenge_to_scalar(c);
    let g_z = exponentiate(&pk.g, &z);
    let h_z = exponentiate(&pk.h, &z);
    let u_e = exponentiate(&pk.u, &e);
    let v_e = exponentiate(&pk.v, &e);
    let a = g_z * &inverse(&u_e);
    let b = h_z * &inverse(&v_e);
    (a, b)
}

// ────────────────────────────────────────────────────────────────────
// Cross-validation gate.
// ────────────────────────────────────────────────────────────────────

pub fn cross_check_with_sigma_rust(
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

// ────────────────────────────────────────────────────────────────────
// Construction helpers for nested conjectures.
// ────────────────────────────────────────────────────────────────────

pub fn make_cand(items: Vec<SigmaBoolean>) -> Result<SigmaBoolean> {
    Ok(SigmaBoolean::SigmaConjecture(SigmaConjecture::Cand(Cand {
        items: SigmaConjectureItems::try_from(items)?,
    })))
}

pub fn make_cor(items: Vec<SigmaBoolean>) -> Result<SigmaBoolean> {
    Ok(SigmaBoolean::SigmaConjecture(SigmaConjecture::Cor(Cor {
        items: SigmaConjectureItems::try_from(items)?,
    })))
}

pub fn make_cthreshold(k: u8, items: Vec<SigmaBoolean>) -> Result<SigmaBoolean> {
    Ok(SigmaBoolean::SigmaConjecture(SigmaConjecture::Cthreshold(
        Cthreshold {
            k,
            children: SigmaConjectureItems::try_from(items)?,
        },
    )))
}
