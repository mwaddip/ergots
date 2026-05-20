//! SAvlTree.insert / SAvlTree.update — per-op-fail-graceful carry-forward fixtures.
//!
//! Phase 2h-d Task 14. Carry-forward fixtures from 2h-b that close two
//! previously-untested branches in `packages/ergoscript/src/eval/savltree.ts`:
//!
//! - **insert V3+ per-op-fail-graceful** (savltree.ts:446-460) —
//!   `treeVersion >= 3` AND `partial.opsCompleted < ops.length` → return
//!   `noneAvlTree()` (no throw). Sigma-rust ref: savltree.rs:260-261 — `break`
//!   gated on `ctx.tree_version() >= ErgoTreeVersion::V3`.
//!
//! - **update per-op-fail-graceful** (savltree.ts:507-510) — `partial.opsCompleted
//!   < ops.length` → return `noneAvlTree()` (unconditional, no V<3 throw split).
//!   Sigma-rust ref: savltree.rs:428-430 — unconditional `break`.
//!
//! - **Optional: insert V<3 per-op-fail-throw** (savltree.ts:464-469) — `treeVersion
//!   < 3` AND `partial.opsCompleted < ops.length` → throw `'avl-tree-proof-failed'`.
//!   Sigma-rust ref: savltree.rs:263-267. Emitted here because the audit of
//!   `savltree-insert.json` (T14 Step 1) found NO existing V<3 throw coverage
//!   (only success-1-entry, success-3-entries, and disallowed-flags scenarios).
//!
//! ## Per-op-fail mechanism (shared by insert + update)
//!
//! Both insert and update operations have an `Err` path in their `update_fn`:
//!   - `Insert(existing_key)` → `Err("Key already exists")` (ergo_avltree_rust
//!     `operation.rs:68-71`).
//!   - `Update(absent_key)` → `Err("Key does not exists")` (operation.rs:72-75).
//!
//! Unlike T10's `insertOrUpdate` per-op-fail trick (which used a
//! directions-mismatch because `InsertOrUpdate::update_fn` has NO Err path),
//! the standard "trip on key existence" mechanism works for both `Insert` and
//! `Update`. However, the **prover** cannot generate a proof for an Err-ing op
//! directly (its own `perform_one_operation` would return Err and refuse to
//! emit the proof slot).
//!
//! Trick: substitute `Operation::Lookup(K)` at the failing slot on the prover
//! side. The prover walks the proof directions for `Lookup(K)` — comparison
//! depends on key only (not op type — see `batch_avl_prover.rs:387-415`) — so
//! the proof's slot-N directions are byte-identical to what `Insert(K)` /
//! `Update(K)` would produce. The verifier reads those directions, walks to
//! the same leaf, and then `update_fn` returns Err. `bv.digest()` is then
//! poisoned to None (`batch_avl_verifier.rs:168`) → handler emits Option None.
//!
//! ## opts_json.treeVersion
//!
//! - **insert V3+ partial**: `opts_json: { "treeVersion": 3 }` — required to
//!   exercise the V3+ break branch (`insert.ts:462-470`); otherwise the TS
//!   handler picks the V<3 throw branch. Captured via
//!   `try_eval_out_with_version(3, 3)` so sigma-rust matches.
//! - **update partial**: `opts_json: { "treeVersion": 0 }` — update has no
//!   V<3/V3+ split; we pick V0 explicitly to assert the unconditional graceful
//!   branch fires regardless of context version (no `ctx` parameter on the TS
//!   handler beyond the unused `_ctx`).
//! - **insert V<3 throw**: `opts_json: { "treeVersion": 0 }` — required to
//!   route into the V<3 throw branch. No sigma-rust oracle (`try_eval_out`
//!   would return Err); emit `expected_value_json: null`, `expected_cost: 0`,
//!   `expected_error_code: "avl-tree-proof-failed"`.
//!
//! Phase 2h-d Task 14.

use std::sync::Arc;

use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_node::{AVLTree, Node, NodeHeader};
use ergo_avltree_rust::operation::{Digest32, KeyValue, Operation};
use ergo_chain_types::ADDigest;
use ergotree_interpreter::eval::test_util::{try_eval_out, try_eval_out_with_version};
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::{INSERT_METHOD, UPDATE_METHOD};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;

use super::savltree_insert::{entries_constant, option_avl_tree_json};

/// Fixture struct extending the standard EvalFixture shape with
/// `expected_error_code` for the optional V<3 throw scenario.
///
/// Mirrors `InsertOrUpdateFixture` in `savltree_insert_or_update.rs` —
/// the canonical pattern for per-arm modules that mix success and error
/// entries.
#[derive(Serialize)]
pub struct PartialSuccessFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for error entries
    pub expected_value_json: JsonValue,
    /// 0 for error entries (convention from coll_exists / extract_register_as)
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct PartialSuccessFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<PartialSuccessFixture>,
}

fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// Build a prover with initial state and capture a proof for a heterogeneous
/// op sequence (mixing modifications + lookups).
///
/// Mirrors the wave-1 + T10 pattern: initial Insert seed ops → discard proof →
/// capture starting digest → apply test ops → capture proof.
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

fn key1(byte: u8) -> Vec<u8> {
    vec![byte]
}

fn val_8(byte: u8) -> Vec<u8> {
    vec![byte; 8]
}

/// Build the MethodCall expr for `tree.insert(entries, proof)`.
fn build_insert_expr(
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
        INSERT_METHOD.clone(),
        vec![entries_expr, proof_expr],
    )
    .map_err(|e| anyhow::anyhow!("MethodCall insert: {:?}", e))?
    .into())
}

/// Build the MethodCall expr for `tree.update(entries, proof)`.
fn build_update_expr(
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
        UPDATE_METHOD.clone(),
        vec![entries_expr, proof_expr],
    )
    .map_err(|e| anyhow::anyhow!("MethodCall update: {:?}", e))?
    .into())
}

/// Build a populated 3-leaf tree and produce a proof for an Insert batch where
/// op 2 targets an already-existing key (collision). The prover side uses
/// `Lookup(existing_key)` at slot 1 so the proof emits the same directions
/// `Insert(existing_key)` would walk; the verifier then trips on
/// `update_fn(Some(_))` returning Err.
///
/// Returns the AvlTreeData (with `digest = starting_digest`) and the fixture
/// entries (verifier-side: Insert ops with the collision at slot 1).
fn build_insert_collision_tree_data(
) -> anyhow::Result<(AvlTreeData, Vec<(Vec<u8>, Vec<u8>)>, Vec<u8>)> {
    // Initial tree: 3 leaves at 0x01/0x02/0x03 (1-byte keys, 8-byte values).
    let initial: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x01), val_8(0x01)),
        (key1(0x02), val_8(0x02)),
        (key1(0x03), val_8(0x03)),
    ];

    // Prover ops:
    //   op 0: Insert(0x10)         — succeeds, inserts new leaf.
    //   op 1: Lookup(0x02)         — read-only walk to existing leaf 0x02.
    //                                Proof captures the directions to that leaf.
    //   op 2: Insert(0x20)         — succeeds, inserts new leaf to the right.
    let prover_ops: Vec<Operation> = vec![
        Operation::Insert(KeyValue {
            key: Bytes::from(key1(0x10)),
            value: Bytes::from(val_8(0xAA)),
        }),
        Operation::Lookup(Bytes::from(key1(0x02))),
        Operation::Insert(KeyValue {
            key: Bytes::from(key1(0x20)),
            value: Bytes::from(val_8(0xCC)),
        }),
    ];

    // Fixture entries (verifier-side):
    //   op 0: Insert(0x10) — matches prover slot 0; succeeds.
    //   op 1: Insert(0x02) — collision with existing leaf 0x02. Proof's slot-1
    //          directions (built from Lookup(0x02) on the prover) walk to leaf
    //          0x02. `key_matches_leaf(0x02, leaf_0x02)` returns true; verifier
    //          calls `update_fn(Some(existing_value))` for Insert → Err
    //          ("Key already exists"). `tree.root = None`. Loop breaks.
    //   op 2: Insert(0x20) — never reached.
    let fixture_entries: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x10), val_8(0xAA)),
        (key1(0x02), val_8(0xBB)),
        (key1(0x20), val_8(0xCC)),
    ];

    let (starting_digest, proof_bytes) = build_proof_for_ops(1, &initial, &prover_ops)?;

    let tree_data = AvlTreeData {
        digest: starting_digest,
        // insert_allowed = true (the path we exercise); update_allowed /
        // remove_allowed irrelevant for insert handler.
        tree_flags: AvlTreeFlags::new(true, false, false),
        key_length: 1,
        value_length_opt: None,
    };

    Ok((tree_data, fixture_entries, proof_bytes))
}

/// **Insert V3+ per-op-fail-graceful** (savltree.ts:446-460).
///
/// `treeVersion >= 3` AND `partial.opsCompleted < ops.length` → return
/// `noneAvlTree()`. Sigma-rust ref: savltree.rs:260-261 (`break` gated on
/// `ctx.tree_version() >= ErgoTreeVersion::V3`).
pub fn generate_insert_partial() -> anyhow::Result<PartialSuccessFixtureFile> {
    let (tree_data, fixture_entries, proof_bytes) = build_insert_collision_tree_data()?;

    let expr = build_insert_expr(tree_data, &fixture_entries, proof_bytes)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    // Use try_eval_out_with_version to force tree_version=3 so sigma-rust takes
    // the V3+ break branch (savltree.rs:260-261) rather than the V<3 throw
    // branch (line 263-267). Roundtrip-parses through sigma_serialize_bytes
    // with tree_version=3 (no-op for insert, but matches the API contract).
    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: Value<'static> = try_eval_out_with_version(&tree.proposition()?, &ctx, 3, 3)?;

    // Capture cost on a fresh V3 context (try_eval_out_with_version clones ctx
    // internally; the outer `ctx.jit_cost_value()` would read 0 because no
    // cost was added to the original ctx). Mirrors coll_by_index.rs:261-264.
    let mut cost_ctx = ctx.clone();
    cost_ctx.pre_header.version = 4; // activated_version=3 → block version=4
    cost_ctx.tree_version.set(3u8.into());
    let _: Value<'static> = try_eval_out(&tree.proposition()?, &cost_ctx)?;
    let cost = cost_ctx.jit_cost_value();

    // Build-time sanity check: per-op-fail must produce Option None.
    if !matches!(&val, Value::Opt(None)) {
        anyhow::bail!(
            "insert V3+ per-op-fail-graceful scenario produced unexpected value \
            (expected Value::Opt(None)): {:?}",
            val
        );
    }

    Ok(PartialSuccessFixtureFile {
        corpus: "eval_savltree_insert_partial",
        entries: vec![PartialSuccessFixture {
            name: "insert_partial_success_v3_graceful".into(),
            tree_bytes_hex,
            opts_json: json!({ "treeVersion": 3 }),
            expected_value_json: option_avl_tree_json(&val)?,
            expected_cost: cost,
            expected_error_code: json!(null),
        }],
    })
}

/// **Update per-op-fail-graceful** (savltree.ts:507-510).
///
/// `partial.opsCompleted < ops.length` → return `noneAvlTree()` (unconditional,
/// no V<3 throw branch — update unconditionally breaks). Sigma-rust ref:
/// savltree.rs:428-430.
///
/// Mechanism: Prover ops include a `Lookup(absent_key)` at slot 1; verifier
/// substitutes `Update(absent_key)` at the same slot. The proof's slot-1
/// directions walk to the leaf where `absent_key` would lie; verifier's
/// `key_matches_leaf` returns Ok(false); `update_fn(None)` for Update returns
/// `Err("Key does not exists")`; `tree.root = None`; loop breaks.
pub fn generate_update_partial() -> anyhow::Result<PartialSuccessFixtureFile> {
    // Initial tree: 3 leaves at 0x01/0x02/0x03 with 8-byte values.
    let initial: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x01), val_8(0x01)),
        (key1(0x02), val_8(0x02)),
        (key1(0x03), val_8(0x03)),
    ];

    // Prover ops:
    //   op 0: Update(0x01)         — succeeds, in-place update of existing leaf.
    //   op 1: Lookup(0xFE)         — walks to leaf 0x03 (rightmost leaf;
    //                                next_node_key = +inf). 0xFE > 0x03 and
    //                                0xFE < +inf → key_matches_leaf returns
    //                                Ok(false). Lookup with no match returns
    //                                Ok(None), so prover succeeds.
    //   op 2: Update(0x03)         — succeeds, in-place update.
    let prover_ops: Vec<Operation> = vec![
        Operation::Update(KeyValue {
            key: Bytes::from(key1(0x01)),
            value: Bytes::from(val_8(0xAA)),
        }),
        Operation::Lookup(Bytes::from(key1(0xFE))),
        Operation::Update(KeyValue {
            key: Bytes::from(key1(0x03)),
            value: Bytes::from(val_8(0xCC)),
        }),
    ];

    // Fixture entries (verifier-side):
    //   op 0: Update(0x01) — matches prover slot 0; succeeds.
    //   op 1: Update(0xFE) — absent key. Proof's slot-1 directions walk to leaf
    //          0x03; `key_matches_leaf(0xFE, leaf_0x03)` returns Ok(false);
    //          verifier calls `update_fn(None)` for Update → Err ("Key does
    //          not exists"). `tree.root = None`. Loop breaks.
    //   op 2: Update(0x03) — never reached.
    let fixture_entries: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key1(0x01), val_8(0xAA)),
        (key1(0xFE), val_8(0xBB)),
        (key1(0x03), val_8(0xCC)),
    ];

    let (starting_digest, proof_bytes) = build_proof_for_ops(1, &initial, &prover_ops)?;

    let tree_data = AvlTreeData {
        digest: starting_digest,
        // update_allowed = true (the path we exercise); insert_allowed /
        // remove_allowed irrelevant for update handler.
        tree_flags: AvlTreeFlags::new(false, true, false),
        key_length: 1,
        value_length_opt: None,
    };

    let expr = build_update_expr(tree_data, &fixture_entries, proof_bytes)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    // Update has no V<3/V3+ split; default ctx (V0) suffices, but we encode
    // `treeVersion: 0` explicitly in opts_json for parity with the convention
    // T11 / T10 established (V-dependent scenarios always carry an explicit
    // `treeVersion` so the TS test's `makeContext({ ...opts_json })` is
    // deterministic).
    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    // Build-time sanity check: per-op-fail must produce Option None.
    if !matches!(&val, Value::Opt(None)) {
        anyhow::bail!(
            "update per-op-fail-graceful scenario produced unexpected value \
            (expected Value::Opt(None)): {:?}",
            val
        );
    }

    Ok(PartialSuccessFixtureFile {
        corpus: "eval_savltree_update_partial",
        entries: vec![PartialSuccessFixture {
            name: "update_partial_success_graceful".into(),
            tree_bytes_hex,
            opts_json: json!({ "treeVersion": 0 }),
            expected_value_json: option_avl_tree_json(&val)?,
            expected_cost: cost,
            expected_error_code: json!(null),
        }],
    })
}

/// **Insert V<3 per-op-fail-throw** (savltree.ts:464-469).
///
/// Optional hardening: audit of existing `savltree-insert.json` (T14 Step 1)
/// found NO V<3 throw coverage — only success-1-entry, success-3-entries, and
/// disallowed-flags scenarios. This fixture closes that gap.
///
/// Uses the same tree_bytes_hex as `generate_insert_partial` (same Insert
/// MethodCall expr + same collision proof) but with `opts_json.treeVersion: 0`
/// to route into the V<3 throw branch. Sigma-rust ref: savltree.rs:263-267.
///
/// No sigma-rust oracle: `try_eval_out_with_version(0, 0)` would return Err
/// (EvalError::AvlTree). We emit `expected_value_json: null`, `expected_cost:
/// 0`, `expected_error_code: "avl-tree-proof-failed"`. Convention from
/// `savltree-insert-or-update`'s `malformed_proof` and `v2_dispatcher_reject`
/// throw entries.
pub fn generate_insert_v2_throw() -> anyhow::Result<PartialSuccessFixtureFile> {
    let (tree_data, fixture_entries, proof_bytes) = build_insert_collision_tree_data()?;

    let expr = build_insert_expr(tree_data, &fixture_entries, proof_bytes)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    Ok(PartialSuccessFixtureFile {
        corpus: "eval_savltree_insert_partial_v2_throw",
        entries: vec![PartialSuccessFixture {
            name: "insert_partial_v2_throw".into(),
            tree_bytes_hex,
            opts_json: json!({ "treeVersion": 0 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("avl-tree-proof-failed"),
        }],
    })
}
