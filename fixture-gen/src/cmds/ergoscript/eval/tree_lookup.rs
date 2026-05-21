//! TreeLookup arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/tree_lookup.rs:20-65
//!   No add_jit_cost — children-only cost.
//!   Eval order: tree → key → proof → BatchAVLVerifier::new → perform_one_operation(Lookup).
//!
//! Returns Value::Opt:
//!   Ok(Some(v))      → Option Some(Coll[Byte])
//!   Ok(None)         → Option None
//!   construct fail   → EvalError::AvlTree(format!("{:?}", e)) (via map_eval_err)
//!   per-op fail      → EvalError::AvlTree(format!("Tree proof is incorrect {:?}", normalized_tree_val))
//!
//! Use BatchAVLProver in fixture-gen (mirrors savltree_get.rs:63-86 pattern)
//! to build the source-of-truth pre-state tree + proof.
//!
//! TS handler: `evalTreeLookup` in `eval/tree-lookup.ts`. Output is an
//! `Option[Coll[Byte]]` SValue: `{ kind: 'Option', elem: SColl(SByte), value: <Coll[Byte] SValue | null> }`.
//!
//! Scenarios (4 happy + 3 throw = 7 total):
//!
//! NOTE: keys MUST be > 0x00 — BatchAVLProver's internal invariant requires
//! `key > negative_infinity_key()` (which is the 0x00 sentinel for 1-byte keys).
//! See `~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs:227`. We use
//! keys 1..11 (10 keys), value pattern val[i] = [i; 8].
//!
//! Happy:
//!   - tl_found_in_10_leaf_low_key      : Insert keys 1..11, lookup key=2 → Some(value)
//!   - tl_absent_in_10_leaf             : Insert keys 1..11, lookup key=100 → None (proof OK, key absent)
//!   - tl_single_leaf_found             : Insert one entry (key=5, val=[5; 8]), lookup key=5 → Some(value)
//!   - tl_found_in_10_leaf_boundary_key : Insert keys 1..11, lookup key=10 (highest inserted) → Some(value)
//!
//! Throw:
//!   - tl_throw_malformed_proof  : 1..11 tree, MUTATE proof bytes → 'avl-tree-proof-failed'
//!   - tl_throw_wrong_digest     : 1..11 tree, modify starting_digest in tree input → 'avl-tree-proof-failed'
//!   - tl_throw_non_avl_receiver : synthetic tree = Const(SInt, 42) → 'avl-tree-obj-not-avl-tree'

use std::sync::Arc;

use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_node::AVLTree;
use ergo_avltree_rust::operation::{KeyValue, Operation};
use ergo_chain_types::ADDigest;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::tree_lookup::TreeLookup;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;
use sigma_ser::ScorexSerializable;

use super::common::{stype_to_json, value_to_json};
use super::savltree_helpers::make_resolver;

#[derive(Serialize)]
pub struct TreeLookupFixture {
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
pub struct TreeLookupFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<TreeLookupFixture>,
}

/// Encode an `Option[Coll[Byte]]` Value as the TS SValue Option variant
/// (mirror of savltree_get.rs:48-59).
fn option_coll_byte_json(value: &Value) -> anyhow::Result<JsonValue> {
    let inner = match value {
        Value::Opt(None) => None,
        Value::Opt(Some(boxed)) => Some(value_to_json(boxed)),
        other => anyhow::bail!("tree_lookup: expected Value::Opt, got {:?}", other),
    };
    let elem = stype_to_json(&ergotree_ir::types::stype::SType::SColl(Arc::new(
        ergotree_ir::types::stype::SType::SByte,
    )));
    Ok(match inner {
        None => json!({ "kind": "Option", "elem": elem, "value": null }),
        Some(v) => json!({ "kind": "Option", "elem": elem, "value": v }),
    })
}

/// Build a prover, populate, capture starting_digest, then perform Lookup and
/// capture proof bytes (mirror of savltree_get.rs:63-86).
fn build_lookup_proof(
    key_length: usize,
    entries: &[(Vec<u8>, Vec<u8>)],
    test_key: &[u8],
) -> anyhow::Result<(ADDigest, Vec<u8>)> {
    let mut prover = BatchAVLProver::new(
        AVLTree::new(make_resolver(), key_length, None),
        true,
    );
    for (k, v) in entries {
        prover.perform_one_operation(&Operation::Insert(KeyValue {
            key: Bytes::from(k.clone()),
            value: Bytes::from(v.clone()),
        }))?;
    }
    let _ = prover.generate_proof();
    let starting_digest_bytes = prover.digest().expect("digest after initial inserts");
    let starting_digest = ADDigest::scorex_parse_bytes(&starting_digest_bytes)?;

    let _ = prover.perform_one_operation(&Operation::Lookup(Bytes::from(test_key.to_vec())))?;
    let proof_bytes = prover.generate_proof().to_vec();

    Ok((starting_digest, proof_bytes))
}

/// Build a `TreeLookup` Expr from concrete AvlTreeData + key + proof bytes.
/// Direct struct construction (bypasses `TreeLookup::new`'s build-time guards
/// for the synthetic non-AvlTree-receiver throw entry).
fn build_tree_lookup_tree(
    tree_expr: Expr,
    key_expr: Expr,
    proof_expr: Expr,
) -> anyhow::Result<(ErgoTree, String)> {
    let node = TreeLookup {
        tree: Box::new(tree_expr),
        key: Box::new(key_expr),
        proof: Box::new(proof_expr),
    };
    let body: Expr = node.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Build a Const(SColl(SByte), bytes) Expr.
fn const_bytes(bytes: Vec<u8>) -> Expr {
    let c: Constant = bytes.into();
    c.into()
}

/// Build a Const(SInt, n) Expr — for the synthetic non-AvlTree-receiver throw.
fn const_int(n: i32) -> Expr {
    let c: Constant = n.into();
    c.into()
}

/// Build a Const(SAvlTree, AvlTreeData) Expr from concrete tree data.
fn const_avl_tree(d: AvlTreeData) -> Expr {
    let c: Constant = d.into();
    c.into()
}

/// Standard happy-path AvlTreeData: key_length=1, value_length_opt=None,
/// tree_flags=AvlTreeFlags::new(false,false,false) (read-only).
fn make_avl_tree_data(digest: ADDigest) -> AvlTreeData {
    AvlTreeData {
        digest,
        tree_flags: AvlTreeFlags::new(false, false, false),
        key_length: 1,
        value_length_opt: None,
    }
}

/// 10-leaf populated tree: keys 1..11 (1 byte), values [n, n, ..., n] × 8 bytes.
/// Keys MUST start at 1 — BatchAVLProver rejects keys <= negative-infinity
/// sentinel (0x00 for 1-byte keys) at authenticated_tree_ops.rs:227.
fn ten_leaf_entries() -> Vec<(Vec<u8>, Vec<u8>)> {
    (1u8..11).map(|i| (vec![i], vec![i; 8])).collect()
}

fn success_entry(
    name: &str,
    key_length: usize,
    entries: &[(Vec<u8>, Vec<u8>)],
    test_key: &[u8],
) -> anyhow::Result<TreeLookupFixture> {
    let (starting_digest, proof_bytes) = build_lookup_proof(key_length, entries, test_key)?;
    let avl_data = AvlTreeData {
        digest: starting_digest,
        tree_flags: AvlTreeFlags::new(false, false, false),
        key_length: key_length as u32,
        value_length_opt: None,
    };

    let tree_expr = const_avl_tree(avl_data);
    let key_expr = const_bytes(test_key.to_vec());
    let proof_expr = const_bytes(proof_bytes);

    let (tree, hex) = build_tree_lookup_tree(tree_expr, key_expr, proof_expr)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(TreeLookupFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: option_coll_byte_json(&val)?,
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<TreeLookupFixtureFile> {
    let mut entries = Vec::new();

    let ten_leaves = ten_leaf_entries();

    // -----------------------------------------------------------------------
    // Happy (4)
    // -----------------------------------------------------------------------

    // 1. tl_found_in_10_leaf_low_key: keys 0..10, lookup key=2 → Some([2;8])
    entries.push(success_entry(
        "tl_found_in_10_leaf_low_key",
        1,
        &ten_leaves,
        &[2u8],
    )?);

    // 2. tl_absent_in_10_leaf: keys 0..10, lookup key=100 → None (key absent
    //    but proof is valid — verifier verifies absence too).
    entries.push(success_entry(
        "tl_absent_in_10_leaf",
        1,
        &ten_leaves,
        &[100u8],
    )?);

    // 3. tl_single_leaf_found: single key=5, lookup key=5 → Some([5;8])
    let single_leaf: Vec<(Vec<u8>, Vec<u8>)> = vec![(vec![5u8], vec![5u8; 8])];
    entries.push(success_entry(
        "tl_single_leaf_found",
        1,
        &single_leaf,
        &[5u8],
    )?);

    // 4. tl_found_in_10_leaf_boundary_key: keys 1..11, lookup key=10 → Some([10;8])
    entries.push(success_entry(
        "tl_found_in_10_leaf_boundary_key",
        1,
        &ten_leaves,
        &[10u8],
    )?);

    // -----------------------------------------------------------------------
    // Throw (3)
    // -----------------------------------------------------------------------

    // 5. tl_throw_malformed_proof: build the valid lookup proof for keys 0..10
    //    + key=2, then MUTATE proof bytes (flip byte 0). Mutation breaks proof
    //    construct (or per-op verification) → TS throws 'avl-tree-proof-failed'.
    //    Sigma-rust eval NOT run — fixture asserts expected_error_code only.
    {
        let (starting_digest, mut proof_bytes) = build_lookup_proof(1, &ten_leaves, &[2u8])?;
        // Mutate the proof by XOR-ing byte 0 with 0xFF (heavy disruption — most
        // likely to break tree-decode at the very first token byte).
        proof_bytes[0] ^= 0xff;
        let avl_data = make_avl_tree_data(starting_digest);
        let tree_expr = const_avl_tree(avl_data);
        let key_expr = const_bytes(vec![2u8]);
        let proof_expr = const_bytes(proof_bytes);
        let (_tree, hex) = build_tree_lookup_tree(tree_expr, key_expr, proof_expr)?;
        entries.push(TreeLookupFixture {
            name: "tl_throw_malformed_proof".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("avl-tree-proof-failed"),
        });
    }

    // 6. tl_throw_wrong_digest: build the valid lookup proof, then alter the
    //    starting_digest in the AvlTreeData input (XOR byte 0 with 0xFF). The
    //    verifier reconstructs a different root from the proof bytes than what
    //    we claim as starting_digest → digest-mismatch → TS throws
    //    'avl-tree-proof-failed'.
    {
        let (starting_digest, proof_bytes) = build_lookup_proof(1, &ten_leaves, &[2u8])?;
        // Mutate the starting digest. ADDigest is exactly 33 bytes; XOR byte 0
        // to ensure a meaningful change.
        let mut digest_bytes = starting_digest.0.to_vec();
        digest_bytes[0] ^= 0xff;
        let mutated_digest = ADDigest::scorex_parse_bytes(&digest_bytes)?;
        let avl_data = make_avl_tree_data(mutated_digest);
        let tree_expr = const_avl_tree(avl_data);
        let key_expr = const_bytes(vec![2u8]);
        let proof_expr = const_bytes(proof_bytes);
        let (_tree, hex) = build_tree_lookup_tree(tree_expr, key_expr, proof_expr)?;
        entries.push(TreeLookupFixture {
            name: "tl_throw_wrong_digest".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("avl-tree-proof-failed"),
        });
    }

    // 7. tl_throw_non_avl_receiver: tree input is `Const(SInt, 42)` instead of
    //    an AvlTree. Built via direct TreeLookup struct construction to bypass
    //    `TreeLookup::new`'s build-time SAvlTree guard. Sigma-rust eval NOT run.
    //    TS handler defensive check throws 'avl-tree-obj-not-avl-tree'.
    {
        let tree_expr = const_int(42);
        let key_expr = const_bytes(vec![2u8]);
        // Any proof bytes — never reached because the tree-kind check happens
        // FIRST in the TS handler. Use a single-byte placeholder.
        let proof_expr = const_bytes(vec![0u8]);
        let (_tree, hex) = build_tree_lookup_tree(tree_expr, key_expr, proof_expr)?;
        entries.push(TreeLookupFixture {
            name: "tl_throw_non_avl_receiver".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("avl-tree-obj-not-avl-tree"),
        });
    }

    Ok(TreeLookupFixtureFile {
        corpus: "eval_tree_lookup",
        entries,
    })
}
