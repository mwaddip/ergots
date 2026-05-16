//! V1 reject + malformed verifier fixtures (phase 2g-medium Task 6).
//!
//! Covers:
//!   - TrivialProp(true)  + arbitrary sig → returns true (short-circuit, sig ignored)
//!   - TrivialProp(false) + arbitrary sig → returns false (short-circuit, sig ignored)
//!   - Cand input                         → throws 'conjecture-not-implemented'
//!   - Cor input                          → throws 'conjecture-not-implemented'
//!   - Cthreshold input                   → throws 'conjecture-not-implemented'
//!   - Empty signature on ProveDlog       → throws 'empty-signature'
//!   - Truncated signature (10 of 56)     → throws 'truncated-signature'
//!
//! TrivialProp short-circuit per verifier.rs:96-98 ignores the signature.
//! Conjecture rejection is the verifier's 2g-medium contract (deferred to
//! 2g-combinators).
//!
//! Source: ergotree-interpreter/src/sigma_protocol/verifier.rs:91-111

use crate::cmds::ergoscript::verify::verifier_positive::build_baseline_triple;
use crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json;
use anyhow::Result;
use ergo_chain_types::ec_point::generator;
use ergotree_ir::sigma_protocol::sigma_boolean::cand::Cand;
use ergotree_ir::sigma_protocol::sigma_boolean::cor::Cor;
use ergotree_ir::sigma_protocol::sigma_boolean::cthreshold::Cthreshold;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDlog, SigmaBoolean, SigmaConjecture, SigmaConjectureItems, SigmaProofOfKnowledgeTree,
};
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Serialize)]
pub struct RejectEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    /// One of: 'returns-true', 'returns-false', or a VerifyError code
    /// like 'conjecture-not-implemented' / 'empty-signature' /
    /// 'truncated-signature'.
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct RejectFixture {
    pub description: &'static str,
    pub entries: Vec<RejectEntry>,
}

fn dlog_leaf() -> SigmaBoolean {
    // A concrete ProveDlog (secp256k1 generator) — we only need a structurally
    // valid leaf to nest inside conjectures.
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(
        generator(),
    )))
}

fn dlog_leaf_alt() -> SigmaBoolean {
    // A second leaf that compares non-equal to dlog_leaf() so SigmaConjectureItems
    // dedup-aware constructors (where present) treat them as distinct.
    use ergo_chain_types::ec_point::exponentiate_gen;
    use k256::Scalar;
    let two = Scalar::from(2u64);
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(
        exponentiate_gen(&two),
    )))
}

fn dlog_leaf_third() -> SigmaBoolean {
    use ergo_chain_types::ec_point::exponentiate_gen;
    use k256::Scalar;
    let three = Scalar::from(3u64);
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(
        exponentiate_gen(&three),
    )))
}

pub fn generate() -> Result<RejectFixture> {
    let mut entries = Vec::new();

    // Build the baseline ProveDlog triple — used as the "arbitrary" signature
    // for TrivialProp short-circuit entries (the verifier must ignore it).
    let (_baseline_sb, _baseline_msg, baseline_sig) = build_baseline_triple()?;

    // 1. TrivialProp(true) — short-circuit returns true regardless of signature.
    entries.push(RejectEntry {
        name: "trivial-true-short-circuit".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&SigmaBoolean::TrivialProp(true)),
        message_hex: hex::encode(b"any-message"),
        signature_hex: hex::encode(&baseline_sig),
        expected_outcome: "returns-true".to_string(),
    });

    // 2. TrivialProp(false) — short-circuit returns false regardless of signature.
    entries.push(RejectEntry {
        name: "trivial-false-short-circuit".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&SigmaBoolean::TrivialProp(false)),
        message_hex: hex::encode(b"any-message"),
        signature_hex: hex::encode(&baseline_sig),
        expected_outcome: "returns-false".to_string(),
    });

    // 3. Cand input → 'conjecture-not-implemented'.
    let cand = SigmaBoolean::SigmaConjecture(SigmaConjecture::Cand(Cand {
        items: SigmaConjectureItems::try_from(vec![dlog_leaf(), dlog_leaf_alt()])?,
    }));
    entries.push(RejectEntry {
        name: "cand-two-leaves".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&cand),
        message_hex: String::new(),
        signature_hex: hex::encode(&baseline_sig),
        expected_outcome: "conjecture-not-implemented".to_string(),
    });

    // 4. Cor input → 'conjecture-not-implemented'.
    let cor = SigmaBoolean::SigmaConjecture(SigmaConjecture::Cor(Cor {
        items: SigmaConjectureItems::try_from(vec![dlog_leaf(), dlog_leaf_alt()])?,
    }));
    entries.push(RejectEntry {
        name: "cor-two-leaves".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&cor),
        message_hex: String::new(),
        signature_hex: hex::encode(&baseline_sig),
        expected_outcome: "conjecture-not-implemented".to_string(),
    });

    // 5. Cthreshold input → 'conjecture-not-implemented'.
    let cthresh = SigmaBoolean::SigmaConjecture(SigmaConjecture::Cthreshold(Cthreshold {
        k: 2,
        children: SigmaConjectureItems::try_from(vec![
            dlog_leaf(),
            dlog_leaf_alt(),
            dlog_leaf_third(),
        ])?,
    }));
    entries.push(RejectEntry {
        name: "cthreshold-2-of-3".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&cthresh),
        message_hex: String::new(),
        signature_hex: hex::encode(&baseline_sig),
        expected_outcome: "conjecture-not-implemented".to_string(),
    });

    // 6. Empty signature on a ProveDlog → 'empty-signature'.
    entries.push(RejectEntry {
        name: "prove-dlog-empty-signature".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&dlog_leaf()),
        message_hex: String::new(),
        signature_hex: String::new(),
        expected_outcome: "empty-signature".to_string(),
    });

    // 7. Truncated signature (10 of 56 bytes) → 'truncated-signature'.
    let truncated = &baseline_sig[..10];
    entries.push(RejectEntry {
        name: "prove-dlog-truncated-signature".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&dlog_leaf()),
        message_hex: String::new(),
        signature_hex: hex::encode(truncated),
        expected_outcome: "truncated-signature".to_string(),
    });

    Ok(RejectFixture {
        description: "V1 reject + malformed verifier fixtures (phase 2g-medium Task 6). Covers TrivialProp short-circuits, conjecture rejection, empty / truncated signatures.",
        entries,
    })
}
