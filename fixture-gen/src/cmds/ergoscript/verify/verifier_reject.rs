//! V1 reject + malformed verifier fixtures (phase 2g-medium Task 6, updated 2g-combinators Task 9).
//!
//! Covers:
//!   - TrivialProp(true)  + arbitrary sig → returns true (short-circuit, sig ignored)
//!   - TrivialProp(false) + arbitrary sig → returns false (short-circuit, sig ignored)
//!   - Empty signature on ProveDlog       → throws 'empty-signature'
//!   - Truncated signature (10 of 56)     → throws 'truncated-signature'
//!
//! TrivialProp short-circuit per verifier.rs:96-98 ignores the signature.
//!
//! As of phase 2g-combinators (Task 9), the verifier handles Cand/Cor/Cthreshold
//! natively; the prior "Cand/Cor/Cthreshold → conjecture-not-implemented"
//! entries have been removed from this fixture. Conjecture-specific reject
//! coverage now lives in verifier-cand-reject.json / verifier-cor-reject.json /
//! verifier-cthreshold-reject.json (Task 8 fixtures).
//!
//! Source: ergotree-interpreter/src/sigma_protocol/verifier.rs:91-111

use crate::cmds::ergoscript::verify::verifier_positive::build_baseline_triple;
use crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json;
use anyhow::Result;
use ergo_chain_types::ec_point::generator;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree,
};
use serde::Serialize;
use serde_json::Value as JsonValue;

/// Concrete ProveDlog at the secp256k1 generator — used as the leaf in the
/// empty/truncated reject entries. (No conjecture nesting needed in 2g-combinators.)
fn dlog_leaf() -> SigmaBoolean {
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(
        generator(),
    )))
}

#[derive(Serialize)]
pub struct RejectEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    pub signature_hex: String,
    /// One of: 'returns-true', 'returns-false', or a VerifyError code
    /// like 'empty-signature' / 'truncated-signature'.
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct RejectFixture {
    pub description: &'static str,
    pub entries: Vec<RejectEntry>,
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

    // Note: Cand/Cor/Cthreshold entries that previously asserted
    // 'conjecture-not-implemented' have been removed in phase 2g-combinators.
    // The verifier now handles conjectures natively; conjecture reject coverage
    // lives in verifier-cand-reject.json / verifier-cor-reject.json /
    // verifier-cthreshold-reject.json (Task 8 fixtures).

    // 3. Empty signature on a ProveDlog → 'empty-signature'.
    entries.push(RejectEntry {
        name: "prove-dlog-empty-signature".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&dlog_leaf()),
        message_hex: String::new(),
        signature_hex: String::new(),
        expected_outcome: "empty-signature".to_string(),
    });

    // 4. Truncated signature (10 of 56 bytes) → 'truncated-signature'.
    let truncated = &baseline_sig[..10];
    entries.push(RejectEntry {
        name: "prove-dlog-truncated-signature".to_string(),
        sigma_boolean_json: sigma_boolean_to_json(&dlog_leaf()),
        message_hex: String::new(),
        signature_hex: hex::encode(truncated),
        expected_outcome: "truncated-signature".to_string(),
    });

    Ok(RejectFixture {
        description: "V1 reject + malformed verifier fixtures (phase 2g-medium Task 6, updated 2g-combinators Task 9). Covers TrivialProp short-circuits and empty / truncated signatures on a ProveDlog leaf. Conjecture-specific reject fixtures live in verifier-{cand,cor,cthreshold}-reject.json.",
        entries,
    })
}
