//! SAvlTree.insertOrUpdate handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:441-498`
//! (INSERT_OR_UPDATE_EVAL_FN). MethodCall typeId=100, methodId=16.
//! Method registration: `ergotree-ir/src/types/savltree.rs::INSERT_OR_UPDATE_METHOD`
//! (INSERT_OR_UPDATE_METHOD_ID = MethodId(16); SType (SAvlTree,
//! Coll[(Coll[Byte], Coll[Byte])], Coll[Byte]) → Option[SAvlTree];
//! min_version V3).
//!
//! Args: `entries: Coll[(Coll[Byte], Coll[Byte])]`, `proof: Coll[Byte]`.
//! Return: `Option[AvlTree]`.
//!
//! Behavior:
//! - `!tree_flags.insert_allowed() || !tree_flags.update_allowed()` →
//!   `Value::Opt(None)` (pre-check at savltree.rs:444).
//! - Verifier construct fail → throw `'avl-tree-proof-failed'`.
//! - Per-op fail → `break` UNCONDITIONALLY (no V<3/V3+ split — the method is
//!   V3-gated at dispatcher level so V<3 never reaches this code). Then
//!   `bv.digest()` returns None (root poisoned) → `Value::Opt(None)`.
//! - All ops succeed → `Some(AvlTree)` with new digest.
//!
//! **No per-handler `ctx.add_jit_cost`** in sigma-rust (line 441). Cost is
//! owned by the lower-level verifier (blake2b per-op work).
//!
//! **V3 dispatcher gate.** The method's MethodDesc has `min_version: V3`. The
//! TS dispatcher (`method-call.ts:143-148`) throws `'tree-version-too-low'`
//! BEFORE invoking the handler when `ctx.treeVersion < 3`. The fixture's
//! `v2-dispatcher-reject` scenario uses byte-identical `tree_bytes_hex` to the
//! happy V3 scenario (same initial tree + same 3-op ops batch + same proof);
//! only `opts_json.treeVersion = 2` differs. The TS test then drives
//! `ctx.treeVersion = 2` to trigger the dispatcher reject. Cost = 0 sentinel
//! for the throw entry; the cost-parity invariant (V<3 reject cost ===
//! V3-receiver+envelope-only cost, with the handler's zero per-handler cost
//! confirming the dispatcher gate suppresses the handler) is checked at the TS
//! level by T12 (parallel-pair pattern mirroring 2h-c.2's `SHeader.checkPow`
//! V<3 reject test).
//!
//! **`opts_json.treeVersion` convention.** All five V3 scenarios (1, 2, 3, 4, 5)
//! encode `opts_json: { "treeVersion": 3 }` so the TS test's `makeContext({
//! ...entry.opts_json })` drives `ctx.treeVersion = 3` past the dispatcher's
//! `minVersion: 3` gate into the handler. Scenario 6 (v2_dispatcher_reject)
//! encodes `treeVersion: 2` to trigger the dispatcher's pre-handler throw.
//! Matches the convention from `downcast.rs` / `option_get_or_else.rs`
//! (V3-requiring entries always carry `opts_json.treeVersion` explicitly).
//!
//! Six scenarios:
//!
//! 1. `insert_or_update_happy_v3` — V3 tree, both flags set, 3-op mixed batch
//!    (2 inserts on absent keys + 1 update on existing key). Expect
//!    `Some(AvlTree(new_digest))`. Captured via `try_eval_out`;
//!    `expected_error_code: null`.
//!
//! 2. `insert_or_update_insert_allowed_false` — V3 tree, `insertAllowed=false,
//!    updateAllowed=true`. Pre-check fails before the verifier runs. Expect
//!    `Option None`. Captured via `try_eval_out`; `expected_error_code: null`.
//!
//! 3. `insert_or_update_update_allowed_false` — V3 tree, `insertAllowed=true,
//!    updateAllowed=false`. Symmetric to #2. Expect `Option None`.
//!
//! 4. `insert_or_update_per_op_fail_graceful` — V3 tree, both flags set,
//!    3-op batch where op 2 carries a key whose binary-search range does NOT
//!    match the proof's directions for that slot. Mechanism: prover ops
//!    `[InsertOrUpdate(0x20), Lookup(0x08), InsertOrUpdate(0x30)]` — the
//!    middle Lookup walks the gap (0x05, 0x10) and the directions point to
//!    leaf 0x05 (with `next_leaf_key = 0x10`). Fixture ops
//!    `[InsertOrUpdate(0x20), InsertOrUpdate(0x14), InsertOrUpdate(0x30)]` —
//!    the middle InsertOrUpdate uses key 0x14, whose binary-search would
//!    naturally land at leaf 0x10, but the directions from the proof lead it
//!    to leaf 0x05. Then `key_matches_leaf(0x14, leaf=0x05)` checks
//!    `0x14 < leaf.next_node_key = 0x10`, which fails (0x14 > 0x10).
//!    `BatchAVLVerifier::perform_one_operation` returns Err, eval breaks,
//!    `bv.digest()` returns None → `Value::Opt(None)`. Captured via
//!    `try_eval_out`; `expected_error_code: null`.
//!
//!    Why a directions-mismatch (not an op-type mismatch or absent-key fail):
//!    `Operation::InsertOrUpdate`'s `update_fn` returns `Ok(Some(...))`
//!    UNCONDITIONALLY (operation.rs:76) — no "key already exists" / "key does
//!    not exist" Err path like Insert / Update have. The only way to trigger
//!    a per-op fail for InsertOrUpdate is at the directions-walking /
//!    key-matching phase, which is exactly what this scenario does.
//!
//! 5. `insert_or_update_malformed_proof` — V3 tree, both flags set, valid
//!    construct shape but with proof bytes corrupted post-generation.
//!    `BatchAVLVerifier::new(...)` returns Err during construct →
//!    `map_eval_err` → `EvalError::AvlTree(...)` → TS-side throws
//!    `'avl-tree-proof-failed'`. We do NOT call `try_eval_out` (returns Err
//!    with no Value); emit `expected_value_json: null`, `expected_cost: 0`,
//!    `expected_error_code: "avl-tree-proof-failed"`. The TS test asserts the
//!    throw on the dispatcher's full pass-through.
//!
//! 6. `insert_or_update_v2_dispatcher_reject` — V2 tree with valid InsertOrUpdate
//!    ops. The dispatcher's `minVersion: 3` gate fires BEFORE the handler runs
//!    (see `method-call.ts:143-148`). Sigma-rust rejects at parse-time with
//!    `UnknownMethodId` when `tree_version < V3` (per
//!    `ergotree-ir/src/serialization/method_call.rs:40-45`). We do NOT call
//!    `try_eval_out_with_version` here either (parse rejects); emit
//!    `opts_json: { "treeVersion": 2 }` (matching the convention from
//!    `downcast.rs` / `option_get_or_else.rs`), `expected_value_json: null`,
//!    `expected_cost: 0`, `expected_error_code: "tree-version-too-low"`. The
//!    TS test reads `treeVersion: 2` from `opts_json` via the standard
//!    `makeContext({ ...entry.opts_json })` pattern. The cost-parity invariant
//!    (V2-reject cost === V3-success-receiver-cost, handler cost is zero) is
//!    verified by T12's parallel-pair cost test.
//!
//! Phase 2h-d Task 10.

use std::sync::Arc;

use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_node::{AVLTree, Node, NodeHeader};
use ergo_avltree_rust::operation::{Digest32, KeyValue, Operation};
use ergo_chain_types::ADDigest;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::INSERT_OR_UPDATE_METHOD;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;

use super::savltree_insert::{entries_constant, option_avl_tree_json};

/// Fixture struct extending the standard EvalFixture shape with
/// `expected_error_code` for the throw scenarios.
///
/// Mirrors `UpdateDigestFixture` in `savltree_update_digest.rs` and
/// `CollExistsFixture` in `coll_exists.rs` — the canonical pattern for
/// per-arm modules that mix success and error entries.
#[derive(Serialize)]
pub struct InsertOrUpdateFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for throw entries
    pub expected_value_json: JsonValue,
    /// 0 for throw entries (convention from coll_exists / extract_register_as)
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct InsertOrUpdateFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<InsertOrUpdateFixture>,
}

fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// Build a `BatchAVLProver` populated with the given initial entries, capture
/// the starting digest, then perform the prover ops and capture the proof
/// bytes. Mirrors the wave-1 fixture pattern.
fn build_proof_for_ops(
    key_length: usize,
    initial_kvs: &[(Vec<u8>, Vec<u8>)],
    prover_ops: &[Operation],
) -> anyhow::Result<(ADDigest, Vec<u8>)> {
    let mut prover = BatchAVLProver::new(
        AVLTree::new(make_resolver(), key_length, None),
        true,
    );
    for (k, v) in initial_kvs {
        prover.perform_one_operation(&Operation::Insert(KeyValue {
            key: Bytes::from(k.clone()),
            value: Bytes::from(v.clone()),
        }))?;
    }
    let _ = prover.generate_proof();
    let starting_digest_bytes = prover.digest().expect("digest after initial inserts");
    let starting_digest = ADDigest::scorex_parse_bytes(&starting_digest_bytes)?;

    for op in prover_ops {
        prover.perform_one_operation(op)?;
    }
    let proof_bytes = prover.generate_proof().to_vec();

    Ok((starting_digest, proof_bytes))
}

/// Build the MethodCall expr for `tree.insertOrUpdate(entries, proof)`.
fn build_insert_or_update_expr(
    tree_data: AvlTreeData,
    fixture_entries: &[(Vec<u8>, Vec<u8>)],
    proof_bytes: Vec<u8>,
) -> anyhow::Result<Expr> {
    let avl_const: Constant = tree_data.into();
    let avl_expr: Expr = avl_const.into();

    let entries_expr: Expr = entries_constant(fixture_entries).into();

    let proof_const: Constant = proof_bytes.into();
    let proof_expr: Expr = proof_const.into();

    Ok(MethodCall::new(
        avl_expr,
        INSERT_OR_UPDATE_METHOD.clone(),
        vec![entries_expr, proof_expr],
    )
    .map_err(|e| anyhow::anyhow!("MethodCall insertOrUpdate: {:?}", e))?
    .into())
}

fn key1(byte: u8) -> Vec<u8> {
    vec![byte]
}

fn val_8(byte: u8) -> Vec<u8> {
    vec![byte; 8]
}

/// Build the happy-pattern `ErgoTree` shared by scenarios 1 (happy_v3) and 6
/// (v2_dispatcher_reject). Both scenarios MUST produce byte-identical
/// `tree_bytes_hex` so T12's cost-parity invariant (V<3 reject cost ===
/// V3-receiver+envelope-only cost) can be asserted rigorously. Only the
/// scenario's `opts_json.treeVersion` differs at the TS level.
fn build_happy_pattern_tree() -> anyhow::Result<ErgoTree> {
    // Initial tree: 3 leaves at 0x01/0x02/0x03 with 8-byte values.
    let initial: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x01), val_8(0x01)),
        (key1(0x02), val_8(0x02)),
        (key1(0x03), val_8(0x03)),
    ];

    // 3 InsertOrUpdate ops: 0x10 (insert, absent), 0x02 (update, existing), 0x20 (insert, absent).
    let fixture_entries: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x10), val_8(0xAA)),
        (key1(0x02), val_8(0xBB)),
        (key1(0x20), val_8(0xCC)),
    ];

    let prover_ops: Vec<Operation> = fixture_entries
        .iter()
        .map(|(k, v)| {
            Operation::InsertOrUpdate(KeyValue {
                key: Bytes::from(k.clone()),
                value: Bytes::from(v.clone()),
            })
        })
        .collect();

    let (starting_digest, proof_bytes) = build_proof_for_ops(1, &initial, &prover_ops)?;

    let tree_data = AvlTreeData {
        digest: starting_digest,
        tree_flags: AvlTreeFlags::new(true, true, false),
        key_length: 1,
        value_length_opt: None,
    };

    let expr = build_insert_or_update_expr(tree_data, &fixture_entries, proof_bytes)?;
    Ok(ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?)
}

/// Scenario 1: happy V3 path — 3 mixed ops (2 inserts + 1 update). Captures
/// the post-batch digest via `try_eval_out`. Reuses `build_happy_pattern_tree`
/// so the emitted `tree_bytes_hex` is byte-identical to scenario 6's
/// `v2_dispatcher_reject` (only `opts_json.treeVersion` differs).
fn make_happy_v3_entry() -> anyhow::Result<InsertOrUpdateFixture> {
    let tree = build_happy_pattern_tree()?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(InsertOrUpdateFixture {
        name: "insert_or_update_happy_v3".into(),
        tree_bytes_hex,
        opts_json: json!({ "treeVersion": 3 }),
        expected_value_json: option_avl_tree_json(&val)?,
        expected_cost: cost,
        expected_error_code: json!(null),
    })
}

/// Scenarios 2 & 3: pre-check fails. `insertAllowed=false` or
/// `updateAllowed=false` short-circuits to `Option None` BEFORE the verifier.
/// We still supply a valid proof (and matching ops) so the eval path doesn't
/// trip on a malformed tree — the pre-check just ignores the proof.
fn make_pre_check_fail_entry(
    name: &str,
    insert_allowed: bool,
    update_allowed: bool,
) -> anyhow::Result<InsertOrUpdateFixture> {
    let initial: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x01), val_8(0x01)),
        (key1(0x02), val_8(0x02)),
        (key1(0x03), val_8(0x03)),
    ];
    let fixture_entries: Vec<(Vec<u8>, Vec<u8>)> = vec![(key1(0x10), val_8(0xAA))];
    let prover_ops: Vec<Operation> = fixture_entries
        .iter()
        .map(|(k, v)| {
            Operation::InsertOrUpdate(KeyValue {
                key: Bytes::from(k.clone()),
                value: Bytes::from(v.clone()),
            })
        })
        .collect();

    let (starting_digest, proof_bytes) = build_proof_for_ops(1, &initial, &prover_ops)?;

    let tree_data = AvlTreeData {
        digest: starting_digest,
        tree_flags: AvlTreeFlags::new(insert_allowed, update_allowed, false),
        key_length: 1,
        value_length_opt: None,
    };

    let expr = build_insert_or_update_expr(tree_data, &fixture_entries, proof_bytes)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(InsertOrUpdateFixture {
        name: name.into(),
        tree_bytes_hex,
        opts_json: json!({ "treeVersion": 3 }),
        expected_value_json: option_avl_tree_json(&val)?,
        expected_cost: cost,
        expected_error_code: json!(null),
    })
}

/// Scenario 4: V3+ per-op-fail-graceful.
///
/// Strategy: directions-mismatch via op-key mismatch. Prover walks Lookup(K1)
/// at op slot 2; fixture submits InsertOrUpdate(K2) at the same slot with K2
/// outside the leaf-range the directions point to. The verifier consumes the
/// proof's directions for slot 2 (built for K1) but with K2 — landing at the
/// "wrong" leaf and failing `key_matches_leaf`. `bv.digest()` poisons to None
/// → eval returns `Value::Opt(None)`.
fn make_per_op_fail_entry() -> anyhow::Result<InsertOrUpdateFixture> {
    // Initial tree with 1-byte leaves: [0x05, 0x10, 0x15]. Inter-leaf gaps:
    //   (NEG_INF, 0x05), (0x05, 0x10), (0x10, 0x15), (0x15, POS_INF).
    let initial: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x05), val_8(0x05)),
        (key1(0x10), val_8(0x10)),
        (key1(0x15), val_8(0x15)),
    ];

    // Prover ops:
    //   op 0: InsertOrUpdate(0x20)  — succeeds, inserts new leaf at right.
    //   op 1: Lookup(0x08)          — gap (0x05, 0x10), directions walk to
    //                                  leaf 0x05 (next_leaf_key = 0x10).
    //   op 2: InsertOrUpdate(0x30)  — succeeds, inserts new leaf at far right.
    let prover_ops: Vec<Operation> = vec![
        Operation::InsertOrUpdate(KeyValue {
            key: Bytes::from(key1(0x20)),
            value: Bytes::from(val_8(0xAA)),
        }),
        Operation::Lookup(Bytes::from(key1(0x08))),
        Operation::InsertOrUpdate(KeyValue {
            key: Bytes::from(key1(0x30)),
            value: Bytes::from(val_8(0xCC)),
        }),
    ];

    // Fixture ops (what the eval handler sends to the verifier):
    //   op 0: InsertOrUpdate(0x20) — same as prover, succeeds.
    //   op 1: InsertOrUpdate(0x14) — key 0x14 sits in gap (0x10, 0x15). The
    //         proof's slot-1 directions walk to leaf 0x05 (built for Lookup
    //         0x08). `key_matches_leaf(0x14, leaf=0x05)` checks
    //         `0x14 < leaf.next_node_key = 0x10` → FAILS (0x14 > 0x10).
    //         Verifier errors → `bv.digest()` poisons to None.
    //   op 2: InsertOrUpdate(0x30) — never reached (loop `break`s on op 1).
    let fixture_entries: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x20), val_8(0xAA)),
        (key1(0x14), val_8(0xBB)),
        (key1(0x30), val_8(0xCC)),
    ];

    let (starting_digest, proof_bytes) = build_proof_for_ops(1, &initial, &prover_ops)?;

    let tree_data = AvlTreeData {
        digest: starting_digest,
        tree_flags: AvlTreeFlags::new(true, true, false),
        key_length: 1,
        value_length_opt: None,
    };

    let expr = build_insert_or_update_expr(tree_data, &fixture_entries, proof_bytes)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    // Sanity assertion at build-time: per-op-fail must produce Option None.
    if !matches!(&val, Value::Opt(None)) {
        anyhow::bail!(
            "per-op-fail scenario produced unexpected value (expected Value::Opt(None)): {:?}",
            val
        );
    }

    Ok(InsertOrUpdateFixture {
        name: "insert_or_update_per_op_fail_graceful".into(),
        tree_bytes_hex,
        opts_json: json!({ "treeVersion": 3 }),
        expected_value_json: option_avl_tree_json(&val)?,
        expected_cost: cost,
        expected_error_code: json!(null),
    })
}

/// Scenario 5: malformed proof.
///
/// Build a valid expr + proof, then corrupt the proof bytes in the
/// already-emitted tree bytes. We don't call `try_eval_out` — sigma-rust
/// would return `Err(EvalError::AvlTree(...))`. TS-side throws
/// `'avl-tree-proof-failed'`.
fn make_malformed_proof_entry() -> anyhow::Result<InsertOrUpdateFixture> {
    let initial: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x01), val_8(0x01)),
        (key1(0x02), val_8(0x02)),
        (key1(0x03), val_8(0x03)),
    ];
    let fixture_entries: Vec<(Vec<u8>, Vec<u8>)> = vec![(key1(0x10), val_8(0xAA))];
    let prover_ops: Vec<Operation> = fixture_entries
        .iter()
        .map(|(k, v)| {
            Operation::InsertOrUpdate(KeyValue {
                key: Bytes::from(k.clone()),
                value: Bytes::from(v.clone()),
            })
        })
        .collect();

    let (starting_digest, mut proof_bytes) = build_proof_for_ops(1, &initial, &prover_ops)?;

    // Corrupt the proof: flip a byte near the middle to break the verifier's
    // construct phase. The exact target doesn't matter — the verifier reads
    // the proof header (tree topology) before any operation, and any
    // non-trivial corruption causes `BatchAVLVerifier::new` to fail.
    if proof_bytes.len() < 4 {
        anyhow::bail!(
            "malformed-proof scenario: proof unexpectedly short ({} bytes)",
            proof_bytes.len()
        );
    }
    let mid = proof_bytes.len() / 2;
    proof_bytes[mid] ^= 0xFF;

    let tree_data = AvlTreeData {
        digest: starting_digest,
        tree_flags: AvlTreeFlags::new(true, true, false),
        key_length: 1,
        value_length_opt: None,
    };

    let expr = build_insert_or_update_expr(tree_data, &fixture_entries, proof_bytes)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    Ok(InsertOrUpdateFixture {
        name: "insert_or_update_malformed_proof".into(),
        tree_bytes_hex,
        opts_json: json!({ "treeVersion": 3 }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("avl-tree-proof-failed"),
    })
}

/// Scenario 6: V<3 dispatcher reject.
///
/// Tree bytes are byte-identical to the happy-V3 scenario via the shared
/// `build_happy_pattern_tree` helper — only `opts_json.treeVersion = 2`
/// differs at the TS level. The TS test passes `opts_json` through
/// `makeContext({ ...entry.opts_json })`; the dispatcher's `minVersion: 3`
/// gate then fires BEFORE the handler runs, throwing `'tree-version-too-low'`.
/// No sigma-rust oracle is consulted (parse-time `UnknownMethodId` rejection).
/// The cost-parity invariant (V2 reject cost === V3 success receiver+envelope
/// cost, since the handler has zero per-handler cost) is verified by T12's
/// parallel-pair cost test — which is only rigorous because the tree bytes
/// (and hence the wire-decode / envelope work) are identical across the pair.
fn make_v2_dispatcher_reject_entry() -> anyhow::Result<InsertOrUpdateFixture> {
    let tree = build_happy_pattern_tree()?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    Ok(InsertOrUpdateFixture {
        name: "insert_or_update_v2_dispatcher_reject".into(),
        tree_bytes_hex,
        opts_json: json!({ "treeVersion": 2 }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("tree-version-too-low"),
    })
}

pub fn generate() -> anyhow::Result<InsertOrUpdateFixtureFile> {
    let entries = vec![
        make_happy_v3_entry()?,
        make_pre_check_fail_entry("insert_or_update_insert_allowed_false", false, true)?,
        make_pre_check_fail_entry("insert_or_update_update_allowed_false", true, false)?,
        make_per_op_fail_entry()?,
        make_malformed_proof_entry()?,
        make_v2_dispatcher_reject_entry()?,
    ];

    Ok(InsertOrUpdateFixtureFile {
        corpus: "eval_savltree_insert_or_update",
        entries,
    })
}
