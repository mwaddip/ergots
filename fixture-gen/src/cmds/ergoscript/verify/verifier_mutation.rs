//! V2 byte-flip mutation verifier fixtures (phase 2g-medium Task 6).
//!
//! Takes one positive ProveDlog (sb, msg, sig) triple — the baseline from
//! `verifier_positive::build_baseline_triple` (seed=1, empty message) —
//! and produces 56 mutation variants. Each variant flips every bit of the
//! byte at one offset (XOR 0xff). The verifier MUST return `false` or
//! throw a typed `VerifyError` on every mutation. Returning `true` is a
//! verifier vulnerability.
//!
//! Source: standard sigma-protocol soundness — any modification to the
//! signature bytes invalidates the recomputed challenge with overwhelming
//! probability. A single-byte flip on a 56-byte (24+32) signature has
//! negligible chance of producing a colliding challenge.

use crate::cmds::ergoscript::verify::verifier_positive::build_baseline_triple;
use crate::cmds::ergoscript::wire::sigma_boolean_variants::sigma_boolean_to_json;
use anyhow::Result;
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Serialize)]
pub struct MutationEntry {
    pub name: String,
    pub sigma_boolean_json: JsonValue,
    pub message_hex: String,
    /// Signature bytes after flipping the byte at `flip_offset` via XOR 0xff.
    pub mutated_signature_hex: String,
    pub flip_offset: usize,
    /// Always 'false-or-error' — the verifier is permitted to either return
    /// false (most flips, including in the 24-byte challenge zone) or throw
    /// a `VerifyError` (if the flip lands on out-of-range scalar bytes etc.).
    /// The only forbidden outcome is `true`.
    pub expected_outcome: String,
}

#[derive(Serialize)]
pub struct MutationFixture {
    pub description: &'static str,
    pub baseline_signature_hex: String,
    pub entries: Vec<MutationEntry>,
}

pub fn generate() -> Result<MutationFixture> {
    let (sb, message, signature) = build_baseline_triple()?;
    let sig_len = signature.len();
    assert_eq!(
        sig_len, 56,
        "baseline ProveDlog signature must be exactly 56 bytes (24 challenge + 32 z)"
    );

    let mut entries = Vec::with_capacity(sig_len);
    for offset in 0..sig_len {
        let mut mutated = signature.clone();
        mutated[offset] ^= 0xff;
        entries.push(MutationEntry {
            name: format!("flip-byte-{:02}", offset),
            sigma_boolean_json: sigma_boolean_to_json(&sb),
            message_hex: hex::encode(&message),
            mutated_signature_hex: hex::encode(&mutated),
            flip_offset: offset,
            expected_outcome: "false-or-error".to_string(),
        });
    }

    Ok(MutationFixture {
        description: "V2 byte-flip mutation fixtures (phase 2g-medium Task 6). Baseline ProveDlog from verifier_positive::build_baseline_triple — 56 single-byte-flip variants. The verifier must return false or throw VerifyError on every entry; returning true is a vulnerability.",
        baseline_signature_hex: hex::encode(&signature),
        entries,
    })
}
