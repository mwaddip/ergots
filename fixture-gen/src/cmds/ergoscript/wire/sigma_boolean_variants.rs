//! Per-variant wire-format fixtures for structural SigmaBoolean (phase 2g-medium Task 1).
//!
//! Generates byte-encoded SigmaBoolean trees for each of the 6 variants
//! plus a few conjecture-nesting combinations. The TS test asserts
//! parse + structural-equal + serialize round-trip.
//!
//! Source:
//!   ergotree-ir/src/serialization/sigmaboolean.rs
//!   ergotree-ir/src/sigma_protocol/sigma_boolean/cand.rs
//!   ergotree-ir/src/sigma_protocol/sigma_boolean/cor.rs
//!   ergotree-ir/src/sigma_protocol/sigma_boolean/cthreshold.rs

use ergo_chain_types::EcPoint;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::cand::Cand;
use ergotree_ir::sigma_protocol::sigma_boolean::cor::Cor;
use ergotree_ir::sigma_protocol::sigma_boolean::cthreshold::Cthreshold;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDhTuple, ProveDlog, SigmaBoolean, SigmaConjecture, SigmaConjectureItems,
    SigmaProofOfKnowledgeTree,
};
use proptest::test_runner::TestRunner;
use proptest::strategy::Strategy;
use proptest::arbitrary::Arbitrary;
use serde::Serialize;

#[derive(Serialize)]
pub struct SigmaBooleanVariantEntry {
    pub name: String,
    /// Hex of the serialized SigmaBoolean (NOT wrapped in ErgoTree).
    pub bytes_hex: String,
    /// Structural description (JSON tree of the SigmaBoolean for the TS test
    /// to assert equality against).
    pub structural_json: serde_json::Value,
}

#[derive(Serialize)]
pub struct SigmaBooleanVariantsFixture {
    pub description: &'static str,
    pub entries: Vec<SigmaBooleanVariantEntry>,
}

fn ec_point_to_hex(p: &EcPoint) -> String {
    hex::encode(p.sigma_serialize_bytes().expect("EcPoint serialize"))
}

pub fn sigma_boolean_to_json(sb: &SigmaBoolean) -> serde_json::Value {
    // Match the TS discriminated-union shape: { tag: '...', ...fields }.
    match sb {
        SigmaBoolean::TrivialProp(b) => serde_json::json!({
            "tag": "TrivialProp",
            "value": b
        }),
        SigmaBoolean::ProofOfKnowledge(pk) => match pk {
            SigmaProofOfKnowledgeTree::ProveDlog(d) => serde_json::json!({
                "tag": "ProveDlog",
                "h": ec_point_to_hex(&d.h)
            }),
            SigmaProofOfKnowledgeTree::ProveDhTuple(d) => serde_json::json!({
                "tag": "ProveDhTuple",
                "g": ec_point_to_hex(&d.g),
                "h": ec_point_to_hex(&d.h),
                "u": ec_point_to_hex(&d.u),
                "v": ec_point_to_hex(&d.v),
            }),
        },
        SigmaBoolean::SigmaConjecture(c) => match c {
            SigmaConjecture::Cand(a) => serde_json::json!({
                "tag": "Cand",
                "items": a.items.iter().map(sigma_boolean_to_json).collect::<Vec<_>>()
            }),
            SigmaConjecture::Cor(o) => serde_json::json!({
                "tag": "Cor",
                "items": o.items.iter().map(sigma_boolean_to_json).collect::<Vec<_>>()
            }),
            SigmaConjecture::Cthreshold(t) => serde_json::json!({
                "tag": "Cthreshold",
                "k": t.k,
                "items": t.children.iter().map(sigma_boolean_to_json).collect::<Vec<_>>()
            }),
        },
    }
}

fn entry(name: &str, sb: SigmaBoolean) -> anyhow::Result<SigmaBooleanVariantEntry> {
    let bytes = sb.sigma_serialize_bytes()?;
    let structural = sigma_boolean_to_json(&sb);
    Ok(SigmaBooleanVariantEntry {
        name: name.to_string(),
        bytes_hex: hex::encode(&bytes),
        structural_json: structural,
    })
}

pub fn generate() -> anyhow::Result<SigmaBooleanVariantsFixture> {
    // Use deterministic TestRunner for force_any_val-like generation via proptest.
    let mut runner = TestRunner::deterministic();

    // Generate 4 deterministic EcPoints using proptest strategy.
    let ec_strategy = EcPoint::arbitrary();
    let pk1 = ec_strategy.new_tree(&mut runner).unwrap().current();
    let pk2 = ec_strategy.new_tree(&mut runner).unwrap().current();
    let pk3 = ec_strategy.new_tree(&mut runner).unwrap().current();
    let pk4 = ec_strategy.new_tree(&mut runner).unwrap().current();

    let dlog1 = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(
        ProveDlog::new(pk1.clone()),
    ));
    let dlog2 = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(
        ProveDlog::new(pk2.clone()),
    ));
    let dlog3 = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(
        ProveDlog::new(pk3.clone()),
    ));

    let mut entries = Vec::new();

    // TrivialProp variants.
    entries.push(entry("trivial-true", SigmaBoolean::TrivialProp(true))?);
    entries.push(entry("trivial-false", SigmaBoolean::TrivialProp(false))?);

    // ProveDlog — single public key.
    entries.push(entry("prove-dlog-basic", dlog1.clone())?);

    // ProveDhTuple — 4 points.
    let dht1 = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDhTuple(
        ProveDhTuple::new(pk1.clone(), pk2.clone(), pk3.clone(), pk4.clone()),
    ));
    entries.push(entry("prove-dh-tuple-basic", dht1)?);

    // Cand — 2 ProveDlog leaves (direct construction, no normalization).
    let cand_2leaves = SigmaBoolean::SigmaConjecture(SigmaConjecture::Cand(Cand {
        items: SigmaConjectureItems::try_from(vec![dlog1.clone(), dlog2.clone()])?,
    }));
    entries.push(entry("cand-two-leaves", cand_2leaves)?);

    // Cor — 2 ProveDlog leaves.
    let cor_2leaves = SigmaBoolean::SigmaConjecture(SigmaConjecture::Cor(Cor {
        items: SigmaConjectureItems::try_from(vec![dlog1.clone(), dlog2.clone()])?,
    }));
    entries.push(entry("cor-two-leaves", cor_2leaves)?);

    // Cthreshold k=2 of 3.
    let cthresh = SigmaBoolean::SigmaConjecture(SigmaConjecture::Cthreshold(Cthreshold {
        k: 2,
        children: SigmaConjectureItems::try_from(vec![dlog1.clone(), dlog2.clone(), dlog3])?,
    }));
    entries.push(entry("cthreshold-2-of-3", cthresh)?);

    Ok(SigmaBooleanVariantsFixture {
        description: "Per-variant wire-format fixtures for structural SigmaBoolean (phase 2g-medium Task 1).",
        entries,
    })
}
