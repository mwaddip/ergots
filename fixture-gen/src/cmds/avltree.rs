use std::sync::Arc;
use std::panic;
use anyhow::Result;
use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_avl_verifier::BatchAVLVerifier;
use ergo_avltree_rust::batch_node::{AVLTree, Node, NodeHeader};
use ergo_avltree_rust::operation::{Digest32, KeyDelta, KeyValue, Operation};
use serde::Serialize;
use std::path::PathBuf;

/// Fixture shape: deserialized by the TS corpus tests.
///
/// `expected_new_digest_hex` is None for rejection fixtures — the TS verifier
/// must return null (i.e. perform_one_operation should fail).  The field is
/// serialized as `null` in JSON (not omitted) so the TS side can distinguish
/// "this fixture expects rejection" from "field missing due to old schema".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AvlFixture {
    name: String,
    starting_digest_hex: String,
    proof_hex: String,
    config: AvlConfig,
    operations: Vec<OpJson>,
    expected_new_digest_hex: Option<String>,
    expected_results_hex: Vec<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AvlConfig {
    key_length: usize,
    value_length_opt: Option<usize>,
    max_num_operations: Option<usize>,
    max_deletes: Option<usize>,
}

#[derive(Serialize)]
#[serde(tag = "tag", rename_all = "PascalCase", rename_all_fields = "camelCase")]
enum OpJson {
    Lookup {
        key_hex: String,
    },
    Insert {
        key_hex: String,
        value_hex: String,
    },
    Update {
        key_hex: String,
        value_hex: String,
    },
    InsertOrUpdate {
        key_hex: String,
        value_hex: String,
    },
    UpdateLongBy {
        key_hex: String,
        delta: i64,
    },
    Remove {
        key_hex: String,
    },
    RemoveIfExists {
        key_hex: String,
    },
    UnknownModification {
        key_hex: String,
    },
}

fn fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .expect("fixture-gen has a parent directory")
        .join("packages/avltree/test/fixtures/avltree")
}

/// Directory for partial-success fixtures (Phase 2h-b Task A1.6). Distinct
/// from the main `avltree/` corpus because the schema differs (no
/// `expected_new_digest_hex`; adds `expected_ops_completed` +
/// `expected_digest_after_N_ops_hex`).
fn partial_fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .expect("fixture-gen has a parent directory")
        .join("packages/avltree/test/fixtures/partial")
}

fn write_fixture(name: &str, fixture: &AvlFixture) -> Result<()> {
    let dir = fixtures_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(fixture)?;
    std::fs::write(&path, json + "\n")?;
    println!("wrote {}", path.display());
    Ok(())
}

fn write_partial_fixture(name: &str, fixture: &PartialFixture) -> Result<()> {
    let dir = partial_fixtures_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(fixture)?;
    std::fs::write(&path, json + "\n")?;
    println!("wrote {}", path.display());
    Ok(())
}

/// Schema for the `insert-fail-at-3-of-5` partial-success fixture
/// (Phase 2h-b Task A1.6).
///
/// Consumed by `@ergots/avltree`'s `verifyAvlBatchPartial` test in Phase A.
/// Differs from `AvlFixture` because partial-success returns
/// `(opsCompleted, newDigest)` instead of "all-or-nothing accept/reject":
///   - `expected_ops_completed`: how many operations succeeded before the
///     first failure (per `verifyAvlBatchPartial` contract).
///   - `expected_digest_after_2_ops_hex`: the digest the verifier should
///     report after exactly 2 ops (matching `expected_ops_completed`).
///     Computed by replaying the same `(starting_digest, proof)` through a
///     fresh `BatchAVLVerifier` and capturing the digest after 2 ops
///     (before attempting the failing op 3).
///
/// Field-key shape matches the task brief verbatim
/// (`expected_digest_after_2_ops_hex` has a literal "2" baked in because
/// this fixture is hand-crafted for exactly the 5-op / fail-at-3 scenario).
/// Nested `config` keeps the existing `AvlConfig` camelCase rename so
/// `keyLength`/`valueLengthOpt` match the main corpus fixtures' shape.
#[derive(Serialize)]
struct PartialFixture {
    description: String,
    starting_digest_hex: String,
    proof_hex: String,
    config: AvlConfig,
    operations: Vec<OpJson>,
    expected_ops_completed: usize,
    expected_digest_after_2_ops_hex: String,
}

/// Resolver used by both prover construction and verifier cross-check.
fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// Build a fresh prover and pre-populate it with `initial_kvs`.
/// Returns `(prover, starting_digest)` where `starting_digest` is the digest
/// AFTER all inserts — this is the "starting point" for the actual test op.
fn make_initial_tree(
    key_length: usize,
    value_length_opt: Option<usize>,
    initial_kvs: &[(Bytes, Bytes)],
) -> Result<(BatchAVLProver, Bytes)> {
    let mut prover = BatchAVLProver::new(
        AVLTree::new(make_resolver(), key_length, value_length_opt),
        true,
    );
    for (k, v) in initial_kvs {
        let op = Operation::Insert(KeyValue {
            key: k.clone(),
            value: v.clone(),
        });
        prover.perform_one_operation(&op)?;
    }
    // Generate and discard the setup proof — we only want the resulting digest.
    let _setup_proof = prover.generate_proof();
    let starting_digest = prover.digest().expect("digest after initial inserts");
    Ok((prover, starting_digest))
}

/// Convert an `Operation` to its `OpJson` representation for the fixture.
fn op_to_json(op: &Operation) -> OpJson {
    match op {
        Operation::Lookup(k) => OpJson::Lookup {
            key_hex: hex::encode(k),
        },
        Operation::Insert(kv) => OpJson::Insert {
            key_hex: hex::encode(&kv.key),
            value_hex: hex::encode(&kv.value),
        },
        Operation::Update(kv) => OpJson::Update {
            key_hex: hex::encode(&kv.key),
            value_hex: hex::encode(&kv.value),
        },
        Operation::InsertOrUpdate(kv) => OpJson::InsertOrUpdate {
            key_hex: hex::encode(&kv.key),
            value_hex: hex::encode(&kv.value),
        },
        Operation::UpdateLongBy(kd) => OpJson::UpdateLongBy {
            key_hex: hex::encode(&kd.key),
            delta: kd.delta,
        },
        Operation::Remove(k) => OpJson::Remove {
            key_hex: hex::encode(k),
        },
        Operation::RemoveIfExists(k) => OpJson::RemoveIfExists {
            key_hex: hex::encode(k),
        },
        Operation::UnknownModification(k) => OpJson::UnknownModification {
            key_hex: hex::encode(k),
        },
    }
}

/// Core helper: run operations on a pre-built initial tree, capture the proof
/// and expected digest, cross-verify with the Rust verifier, and return an
/// `AvlFixture`.
///
/// `prover_ops` are used to build the proof (must all succeed on the prover).
/// `fixture_ops` are recorded in the fixture JSON and replayed by the verifier.
/// For success fixtures, `fixture_ops == prover_ops`.
/// For rejection fixtures, `prover_ops` are typically Lookup(same key) to
/// generate a valid proof for the key's path, while `fixture_ops` are the
/// operations that should cause the verifier to reject.
///
/// `expects_rejection`: if true, the verifier must fail on at least one
/// fixture_op; `expected_new_digest_hex` is `None` in the fixture.
fn generate_fixture(
    name: &str,
    key_length: usize,
    value_length_opt: Option<usize>,
    initial_kvs: &[(Bytes, Bytes)],
    prover_ops: Vec<Operation>,
    fixture_ops: Vec<Operation>,
    expects_rejection: bool,
) -> Result<AvlFixture> {
    assert_eq!(
        prover_ops.len(), fixture_ops.len(),
        "Fixture '{}': prover_ops and fixture_ops must have the same length",
        name
    );
    // --- Prover phase ---
    let (mut prover, starting_digest) =
        make_initial_tree(key_length, value_length_opt, initial_kvs)?;

    let num_ops = fixture_ops.len();
    let num_deletes = fixture_ops.iter().filter(|op| {
        matches!(op, Operation::Remove(_) | Operation::RemoveIfExists(_))
    }).count();

    let mut prover_results: Vec<Option<Bytes>> = Vec::new();
    for op in &prover_ops {
        let result = prover.perform_one_operation(op)?;
        prover_results.push(result);
    }
    let proof = prover.generate_proof();
    let prover_new_digest = prover.digest().expect("post-op digest");

    // --- Verifier cross-check ---
    let mut verifier = BatchAVLVerifier::new(
        &starting_digest,
        &proof,
        AVLTree::new(make_resolver(), key_length, value_length_opt),
        Some(num_ops),
        Some(num_deletes),
    )?;

    if expects_rejection {
        // Run verifier with fixture_ops; at least one must fail.
        let mut rejected = false;
        for op in &fixture_ops {
            if verifier.perform_one_operation(op).is_err() {
                rejected = true;
                break;
            }
        }
        assert!(
            rejected,
            "Fixture '{}' expects rejection but verifier accepted all operations",
            name
        );
        Ok(AvlFixture {
            name: name.to_string(),
            starting_digest_hex: hex::encode(&starting_digest),
            proof_hex: hex::encode(&proof),
            config: AvlConfig {
                key_length,
                value_length_opt,
                max_num_operations: Some(num_ops),
                max_deletes: Some(num_deletes),
            },
            operations: fixture_ops.iter().map(op_to_json).collect(),
            expected_new_digest_hex: None,
            // For rejection fixtures the prover ops may differ; record None for
            // each fixture op's expected result.
            expected_results_hex: fixture_ops.iter().map(|_| None).collect(),
        })
    } else {
        // All verifier ops must succeed; digest must match prover.
        let mut verifier_results: Vec<Option<Bytes>> = Vec::new();
        for op in &fixture_ops {
            let r = verifier.perform_one_operation(op)?;
            verifier_results.push(r);
        }
        let verifier_new_digest = verifier.digest().expect("verifier post-op digest");
        assert_eq!(
            prover_new_digest, verifier_new_digest,
            "Fixture '{}': prover/verifier digest mismatch",
            name
        );
        assert_eq!(
            prover_results, verifier_results,
            "Fixture '{}': prover/verifier operation result mismatch",
            name
        );

        Ok(AvlFixture {
            name: name.to_string(),
            starting_digest_hex: hex::encode(&starting_digest),
            proof_hex: hex::encode(&proof),
            config: AvlConfig {
                key_length,
                value_length_opt,
                max_num_operations: Some(num_ops),
                max_deletes: Some(num_deletes),
            },
            operations: fixture_ops.iter().map(op_to_json).collect(),
            expected_new_digest_hex: Some(hex::encode(&prover_new_digest)),
            expected_results_hex: prover_results
                .iter()
                .map(|r| r.as_ref().map(|v| hex::encode(v)))
                .collect(),
        })
    }
}

// ---------------------------------------------------------------------------
// Key / value helpers
// ---------------------------------------------------------------------------

fn key(byte: u8) -> Bytes {
    Bytes::from(vec![byte; 32])
}

fn val(byte: u8, len: usize) -> Bytes {
    Bytes::from(vec![byte; len])
}

fn val_i64(n: i64) -> Bytes {
    Bytes::from(n.to_be_bytes().to_vec())
}

// 3-leaf pre-state: keys 0x01, 0x02, 0x03 with 8-byte values 0x01…, 0x02…, 0x03…
fn three_leaves(value_length_opt: Option<usize>) -> Vec<(Bytes, Bytes)> {
    let vlen = value_length_opt.unwrap_or(8);
    vec![
        (key(0x01), val(0x01, vlen)),
        (key(0x02), val(0x02, vlen)),
        (key(0x03), val(0x03, vlen)),
    ]
}

// ---------------------------------------------------------------------------
// First fixture (kept for backwards compatibility with T9 proof-decode tests)
// ---------------------------------------------------------------------------

fn single_leaf_insert() -> Result<AvlFixture> {
    let key_length = 32;
    let value_length_opt = None;
    let mut prover = BatchAVLProver::new(
        AVLTree::new(make_resolver(), key_length, value_length_opt),
        true,
    );
    let starting_digest = prover.digest().expect("empty-tree digest");

    let k = Bytes::from(vec![0x42u8; 32]);
    let v = Bytes::from(vec![0x55u8; 8]);
    let op = Operation::Insert(KeyValue {
        key: k.clone(),
        value: v.clone(),
    });

    let result = prover.perform_one_operation(&op)?;
    let proof = prover.generate_proof();
    let new_digest = prover.digest().expect("post-insert digest");

    let mut verifier = BatchAVLVerifier::new(
        &starting_digest,
        &proof,
        AVLTree::new(make_resolver(), key_length, value_length_opt),
        Some(1),
        Some(0),
    )?;
    let verifier_result = verifier.perform_one_operation(&op)?;
    let verifier_new_digest = verifier.digest().expect("verifier post-op digest");
    assert_eq!(new_digest, verifier_new_digest, "prover/verifier digest mismatch");
    assert_eq!(result, verifier_result, "prover/verifier operation result mismatch");

    Ok(AvlFixture {
        name: "single-leaf-insert".to_string(),
        starting_digest_hex: hex::encode(&starting_digest),
        proof_hex: hex::encode(&proof),
        config: AvlConfig {
            key_length,
            value_length_opt,
            max_num_operations: Some(1),
            max_deletes: Some(0),
        },
        operations: vec![OpJson::Insert {
            key_hex: hex::encode(&k),
            value_hex: hex::encode(&v),
        }],
        expected_new_digest_hex: Some(hex::encode(&new_digest)),
        expected_results_hex: vec![result.map(|v| hex::encode(&v))],
    })
}

// ---------------------------------------------------------------------------
// Lookup fixtures
// ---------------------------------------------------------------------------

fn lookup_3leaves_present() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0x02 is present
    let op = Operation::Lookup(key(0x02));
    generate_fixture(
        "lookup-3leaves-present",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn lookup_3leaves_absent() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0xAA is absent
    let op = Operation::Lookup(key(0xAA));
    generate_fixture(
        "lookup-3leaves-absent",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

// ---------------------------------------------------------------------------
// Insert fixtures
// ---------------------------------------------------------------------------

fn insert_3leaves() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0x04 is new
    let op = Operation::Insert(KeyValue {
        key: key(0x04),
        value: val(0x04, 8),
    });
    generate_fixture("insert-3leaves", 32, None, &initial, vec![op.clone()], vec![op], false)
}

fn insert_100leaves() -> Result<AvlFixture> {
    // Build 100-leaf pre-state: keys 0x01..0x64 (skip 0x00 = negative-infinity sentinel),
    // values matching byte repeated 8×.
    let initial: Vec<(Bytes, Bytes)> = (1u8..=100)
        .map(|i| (key(i), val(i, 8)))
        .collect();
    // Insert key 0xFE (new, not in 0x01..0x64 range)
    let op = Operation::Insert(KeyValue {
        key: key(0xFE),
        value: val(0xFE, 8),
    });
    generate_fixture("insert-100leaves", 32, None, &initial, vec![op.clone()], vec![op], false)
}

// ---------------------------------------------------------------------------
// Update fixtures
// ---------------------------------------------------------------------------

fn update_3leaves_present() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // Update key 0x02 to a new value
    let op = Operation::Update(KeyValue {
        key: key(0x02),
        value: val(0xBB, 8),
    });
    generate_fixture(
        "update-3leaves-present",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn update_3leaves_absent_fail() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0xAA is absent. Prover uses Lookup(0xAA) to generate a valid proof
    // for the key's path; fixture records Update(0xAA) which the verifier rejects.
    let absent_key = key(0xAA);
    let prover_op = Operation::Lookup(absent_key.clone());
    let fixture_op = Operation::Update(KeyValue {
        key: absent_key,
        value: val(0xBB, 8),
    });
    generate_fixture(
        "update-3leaves-absent-fail",
        32,
        None,
        &initial,
        vec![prover_op],
        vec![fixture_op],
        true, // expects rejection
    )
}

// ---------------------------------------------------------------------------
// InsertOrUpdate fixtures
// ---------------------------------------------------------------------------

fn insert_or_update_3leaves_absent() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0xAA is absent — takes the insert path
    let op = Operation::InsertOrUpdate(KeyValue {
        key: key(0xAA),
        value: val(0xBB, 8),
    });
    generate_fixture(
        "insert-or-update-3leaves-absent",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn insert_or_update_3leaves_present() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0x02 is present — takes the update path
    let op = Operation::InsertOrUpdate(KeyValue {
        key: key(0x02),
        value: val(0xCC, 8),
    });
    generate_fixture(
        "insert-or-update-3leaves-present",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

// ---------------------------------------------------------------------------
// UpdateLongBy fixtures  (value_length_opt = Some(8) — i64 big-endian)
// ---------------------------------------------------------------------------

fn update_long_by_positive_no_remove() -> Result<AvlFixture> {
    // Pre-state: key 0x01 = i64(10)
    let initial = vec![(key(0x01), val_i64(10))];
    // delta = +5 → new value = 15, no remove
    let op = Operation::UpdateLongBy(KeyDelta {
        key: key(0x01),
        delta: 5,
    });
    generate_fixture(
        "update-long-by-positive-no-remove",
        32,
        Some(8),
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn update_long_by_positive_to_zero_remove() -> Result<AvlFixture> {
    // Pre-state: key 0x01 = i64(5)
    let initial = vec![(key(0x01), val_i64(5))];
    // delta = -5 → new value = 0 → key is removed
    let op = Operation::UpdateLongBy(KeyDelta {
        key: key(0x01),
        delta: -5,
    });
    generate_fixture(
        "update-long-by-to-zero-remove",
        32,
        Some(8),
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn update_long_by_negative_delta_remove() -> Result<AvlFixture> {
    // Pre-state: key 0x01 = i64(100)
    let initial = vec![(key(0x01), val_i64(100))];
    // delta = -100 → new value = 0 → key removed
    let op = Operation::UpdateLongBy(KeyDelta {
        key: key(0x01),
        delta: -100,
    });
    generate_fixture(
        "update-long-by-negative-delta-remove",
        32,
        Some(8),
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn update_long_by_negative_absent_fail() -> Result<AvlFixture> {
    // Pre-state: key 0x01 = i64(10); key 0xAA is absent.
    // Prover uses Lookup(0xAA) to generate a valid proof for the key's path;
    // fixture records UpdateLongBy(0xAA, -5) which the verifier rejects.
    let initial = vec![(key(0x01), val_i64(10))];
    let absent_key = key(0xAA);
    let prover_op = Operation::Lookup(absent_key.clone());
    let fixture_op = Operation::UpdateLongBy(KeyDelta {
        key: absent_key,
        delta: -5,
    });
    generate_fixture(
        "update-long-by-negative-absent-fail",
        32,
        Some(8),
        &initial,
        vec![prover_op],
        vec![fixture_op],
        true, // expects rejection
    )
}

// ---------------------------------------------------------------------------
// Remove fixtures
// ---------------------------------------------------------------------------

fn remove_3leaves_present() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // Remove key 0x02 which exists
    let op = Operation::Remove(key(0x02));
    generate_fixture(
        "remove-3leaves-present",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn remove_3leaves_absent_fail() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0xAA is absent. Prover uses Lookup(0xAA); fixture records Remove(0xAA)
    // which the verifier rejects.
    let absent_key = key(0xAA);
    let prover_op = Operation::Lookup(absent_key.clone());
    let fixture_op = Operation::Remove(absent_key);
    generate_fixture(
        "remove-3leaves-absent-fail",
        32,
        None,
        &initial,
        vec![prover_op],
        vec![fixture_op],
        true, // expects rejection
    )
}

// ---------------------------------------------------------------------------
// RemoveIfExists fixtures
// ---------------------------------------------------------------------------

fn remove_if_exists_3leaves_present() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // Remove key 0x02 which exists
    let op = Operation::RemoveIfExists(key(0x02));
    generate_fixture(
        "remove-if-exists-3leaves-present",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn remove_if_exists_3leaves_absent_noop() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0xAA absent — RemoveIfExists is a no-op (succeeds, returns None)
    let op = Operation::RemoveIfExists(key(0xAA));
    generate_fixture(
        "remove-if-exists-3leaves-absent-noop",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

// ---------------------------------------------------------------------------
// UnknownModification fixtures
// ---------------------------------------------------------------------------

fn unknown_mod_3leaves_present() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0x02 exists — UnknownModification returns old value
    let op = Operation::UnknownModification(key(0x02));
    generate_fixture(
        "unknown-mod-3leaves-present",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn unknown_mod_3leaves_absent() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    // key 0xAA absent — UnknownModification returns None
    let op = Operation::UnknownModification(key(0xAA));
    generate_fixture(
        "unknown-mod-3leaves-absent",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

// ---------------------------------------------------------------------------
// Multi-op batch fixtures (T21)
// ---------------------------------------------------------------------------

/// Empty op list on a 3-leaf tree. Proof covers no key paths; digest unchanged.
fn batch_0ops() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    generate_fixture(
        "batch-0ops",
        32,
        None,
        &initial,
        vec![],
        vec![],
        false,
    )
}

/// Insert key K then Lookup K — verifier should find it.
fn batch_2ops_insert_then_lookup() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    let k = key(0x10);
    let v = val(0xAA, 8);
    let ops = vec![
        Operation::Insert(KeyValue { key: k.clone(), value: v.clone() }),
        Operation::Lookup(k),
    ];
    generate_fixture(
        "batch-2ops-insert-then-lookup",
        32,
        None,
        &initial,
        ops.clone(),
        ops,
        false,
    )
}

/// Insert key K with value V1 then Update K with V2 — final stored value is V2.
fn batch_2ops_insert_then_update() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    let k = key(0x20);
    let v1 = val(0x11, 8);
    let v2 = val(0x22, 8);
    let ops = vec![
        Operation::Insert(KeyValue { key: k.clone(), value: v1 }),
        Operation::Update(KeyValue { key: k, value: v2 }),
    ];
    generate_fixture(
        "batch-2ops-insert-then-update",
        32,
        None,
        &initial,
        ops.clone(),
        ops,
        false,
    )
}

/// Insert key K then Remove K — net-zero change; tree should return to its
/// pre-insert state (though the actual digest may differ due to structural
/// rebalancing history — what matters is that the Rust verifier agrees).
fn batch_2ops_insert_then_remove() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    let k = key(0x30);
    let v = val(0x33, 8);
    let ops = vec![
        Operation::Insert(KeyValue { key: k.clone(), value: v }),
        Operation::Remove(k),
    ];
    generate_fixture(
        "batch-2ops-insert-then-remove",
        32,
        None,
        &initial,
        ops.clone(),
        ops,
        false,
    )
}

/// Build a key with a 2-byte distinguishable prefix so the 32-byte keys are
/// clearly distinct.
fn key2(hi: u8, lo: u8) -> Bytes {
    let mut b = vec![0u8; 32];
    b[0] = hi;
    b[1] = lo;
    Bytes::from(b)
}

/// 16 mixed operations on a 5-leaf initial tree.
fn batch_16ops_mixed() -> Result<AvlFixture> {
    let initial: Vec<(Bytes, Bytes)> = (0x01u8..=0x05)
        .map(|i| (key(i), val(i, 8)))
        .collect();

    // Keys 0xA0..0xA7 are new (absent in initial); keys 0x01..0x05 are present.
    let ops = vec![
        // Insert 4 new keys
        Operation::Insert(KeyValue { key: key2(0xA0, 0), value: val(0xA0, 8) }),
        Operation::Insert(KeyValue { key: key2(0xA1, 0), value: val(0xA1, 8) }),
        Operation::Insert(KeyValue { key: key2(0xA2, 0), value: val(0xA2, 8) }),
        Operation::Insert(KeyValue { key: key2(0xA3, 0), value: val(0xA3, 8) }),
        // Lookup 2 newly inserted keys
        Operation::Lookup(key2(0xA0, 0)),
        Operation::Lookup(key2(0xA1, 0)),
        // Update 2 original keys
        Operation::Update(KeyValue { key: key(0x01), value: val(0xFF, 8) }),
        Operation::Update(KeyValue { key: key(0x02), value: val(0xEE, 8) }),
        // InsertOrUpdate (insert path — absent)
        Operation::InsertOrUpdate(KeyValue { key: key2(0xB0, 0), value: val(0xB0, 8) }),
        // InsertOrUpdate (update path — present)
        Operation::InsertOrUpdate(KeyValue { key: key(0x03), value: val(0xDD, 8) }),
        // RemoveIfExists (present)
        Operation::RemoveIfExists(key(0x04)),
        // RemoveIfExists (absent — no-op)
        Operation::RemoveIfExists(key2(0xC0, 0)),
        // Remove (present)
        Operation::Remove(key(0x05)),
        // Lookup a key that was just removed (should be absent)
        Operation::Lookup(key(0x05)),
        // UnknownModification on an existing key
        Operation::UnknownModification(key(0x01)),
        // Final lookup on a newly inserted key
        Operation::Lookup(key2(0xA2, 0)),
    ];
    generate_fixture(
        "batch-16ops-mixed",
        32,
        None,
        &initial,
        ops.clone(),
        ops,
        false,
    )
}

/// 256 distinct inserts into an empty tree.  Stresses tree depth and
/// previousLeaf-chaining in the proof decoder.
///
/// Keys are structured as [hi, lo, 0x00, ..., 0x00] where (hi, lo) runs
/// over (0x01, 0x00)..(0x01, 0xFF) for 255 keys, then (0x02, 0x00) for 1 more.
/// All keys are strictly less than the positive-infinity sentinel [0xFF; 32].
fn batch_256ops_inserts() -> Result<AvlFixture> {
    // 255 keys: [0x01, lo, 0, ..., 0] for lo in 0x00..=0xFE
    let mut ops: Vec<Operation> = (0x00u8..=0xFEu8)
        .map(|lo| {
            let k = key2(0x01, lo);
            Operation::Insert(KeyValue { key: k, value: val(lo, 8) })
        })
        .collect();
    // 256th key: [0x02, 0x00, 0x00, ..., 0x00]
    ops.push(Operation::Insert(KeyValue {
        key: key2(0x02, 0x00),
        value: val(0x42, 8),
    }));
    assert_eq!(ops.len(), 256);

    generate_fixture(
        "batch-256ops-inserts",
        32,
        None,
        &[],           // empty initial tree
        ops.clone(),
        ops,
        false,
    )
}

/// 100 mixed ops on a starting tree of ~50 leaves.
/// Leaves: keys 0x01..=0x32 (50 leaves), values matching byte.
/// Ops:
///   - Insert 20 new keys (0xC0..=0xD3)
///   - Update 10 existing keys (0x01..=0x0A, new value 0xF0)
///   - Lookup 10 existing keys (0x0B..=0x14)
///   - Remove 10 existing keys (0x15..=0x1E)
///   - RemoveIfExists 10 existing keys (0x1F..=0x28)
///   - InsertOrUpdate 10 new keys (0xD4..=0xDD, insert path)
///   - InsertOrUpdate 10 existing keys (0x29..=0x32, update path)
///   - Lookup 10 previously removed keys (0x15..=0x1E, now absent)
///   Total = 20+10+10+10+10+10+10+10 = 90; pad with 10 more:
///   - UnknownModification on 10 existing keys (0x01..=0x0A)
fn batch_stress_mixed_100() -> Result<AvlFixture> {
    let initial: Vec<(Bytes, Bytes)> = (0x01u8..=0x32)
        .map(|i| (key(i), val(i, 8)))
        .collect();
    assert_eq!(initial.len(), 50);

    let mut ops: Vec<Operation> = Vec::with_capacity(100);

    // Insert 20 new keys
    for i in 0xC0u8..=0xD3u8 {
        ops.push(Operation::Insert(KeyValue { key: key(i), value: val(i, 8) }));
    }
    // Update 10 existing keys
    for i in 0x01u8..=0x0Au8 {
        ops.push(Operation::Update(KeyValue { key: key(i), value: val(0xF0, 8) }));
    }
    // Lookup 10 existing keys
    for i in 0x0Bu8..=0x14u8 {
        ops.push(Operation::Lookup(key(i)));
    }
    // Remove 10 existing keys
    for i in 0x15u8..=0x1Eu8 {
        ops.push(Operation::Remove(key(i)));
    }
    // RemoveIfExists 10 existing keys
    for i in 0x1Fu8..=0x28u8 {
        ops.push(Operation::RemoveIfExists(key(i)));
    }
    // InsertOrUpdate 10 new keys (insert path)
    for i in 0xD4u8..=0xDDu8 {
        ops.push(Operation::InsertOrUpdate(KeyValue { key: key(i), value: val(i, 8) }));
    }
    // InsertOrUpdate 10 existing keys (update path)
    for i in 0x29u8..=0x32u8 {
        ops.push(Operation::InsertOrUpdate(KeyValue { key: key(i), value: val(0xBB, 8) }));
    }
    // Lookup 10 previously removed keys (now absent)
    for i in 0x15u8..=0x1Eu8 {
        ops.push(Operation::Lookup(key(i)));
    }
    // UnknownModification 10 existing keys (0x01..=0x0A, which were updated above)
    for i in 0x01u8..=0x0Au8 {
        ops.push(Operation::UnknownModification(key(i)));
    }

    assert_eq!(ops.len(), 100);

    generate_fixture(
        "batch-stress-mixed-100",
        32,
        None,
        &initial,
        ops.clone(),
        ops,
        false,
    )
}

// ---------------------------------------------------------------------------
// Edge-case fixtures (T22)
// ---------------------------------------------------------------------------

// ---- Empty-tree Lookup ----

/// Lookup on a completely empty tree (no initial KVs).
/// The proof covers the full negative-to-positive-infinity path.
fn empty_tree_lookup() -> Result<AvlFixture> {
    let op = Operation::Lookup(key(0x42));
    generate_fixture(
        "empty-tree-lookup",
        32,
        None,
        &[],
        vec![op.clone()],
        vec![op],
        false,
    )
}

// ---- Single-leaf tree — one fixture per Operation variant ----

/// Starting tree: one leaf, key=0x01, value=0x01×8 (variable-length value).
/// Lookup the only key → returns the value.
fn single_leaf_tree_lookup() -> Result<AvlFixture> {
    let initial = vec![(key(0x01), val(0x01, 8))];
    let op = Operation::Lookup(key(0x01));
    generate_fixture(
        "single-leaf-tree-lookup",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// Starting tree: one leaf, key=0x01. Insert a second key=0x02.
/// (The original `single-leaf-insert` inserts into an *empty* tree; this
/// inserts into a 1-leaf tree, exercising a real path-split.)
fn single_leaf_tree_insert() -> Result<AvlFixture> {
    let initial = vec![(key(0x01), val(0x01, 8))];
    let op = Operation::Insert(KeyValue {
        key: key(0x02),
        value: val(0x02, 8),
    });
    generate_fixture(
        "single-leaf-tree-insert",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// Starting tree: one leaf, key=0x01. Update the only key to a new value.
fn single_leaf_tree_update() -> Result<AvlFixture> {
    let initial = vec![(key(0x01), val(0x01, 8))];
    let op = Operation::Update(KeyValue {
        key: key(0x01),
        value: val(0xFF, 8),
    });
    generate_fixture(
        "single-leaf-tree-update",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// Starting tree: one leaf, key=0x01. InsertOrUpdate with an absent key →
/// insert path.
fn single_leaf_tree_insert_or_update() -> Result<AvlFixture> {
    let initial = vec![(key(0x01), val(0x01, 8))];
    let op = Operation::InsertOrUpdate(KeyValue {
        key: key(0x02),
        value: val(0xCC, 8),
    });
    generate_fixture(
        "single-leaf-tree-insert-or-update",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// Starting tree: one leaf, key=0x01.  Remove the only leaf → tree becomes
/// empty (contains only sentinels).
fn single_leaf_tree_remove() -> Result<AvlFixture> {
    let initial = vec![(key(0x01), val(0x01, 8))];
    let op = Operation::Remove(key(0x01));
    generate_fixture(
        "single-leaf-tree-remove",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// Starting tree: one leaf, key=0x01.  RemoveIfExists on the only leaf.
fn single_leaf_tree_remove_if_exists() -> Result<AvlFixture> {
    let initial = vec![(key(0x01), val(0x01, 8))];
    let op = Operation::RemoveIfExists(key(0x01));
    generate_fixture(
        "single-leaf-tree-remove-if-exists",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

// ---- Skewed insertion trees ----

/// Build a 10-leaf tree with monotonically increasing keys
/// ([0x01, 0, …, 0] .. [0x0A, 0, …, 0]).
/// Monotone inserts force maximal right-rotations during construction; the
/// resulting tree has a well-defined shape that tests rebalancing.
/// The "test op" is a Lookup of the middle key to validate the final digest.
fn all_left_spine_10leaves() -> Result<AvlFixture> {
    // 10 keys in ascending order: [i, 0, …, 0] for i = 1..=10
    let initial: Vec<(Bytes, Bytes)> = (1u8..=10u8)
        .map(|i| (key(i), val(i, 8)))
        .collect();
    // Lookup the middle key to produce a non-trivial proof
    let op = Operation::Lookup(key(0x05));
    generate_fixture(
        "all-left-spine-10leaves",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// Build a 10-leaf tree with monotonically *decreasing* keys
/// ([0x0A, 0, …, 0] down to [0x01, 0, …, 0]).
/// Decreasing inserts force maximal left-rotations; mirror of the above.
fn all_right_spine_10leaves() -> Result<AvlFixture> {
    // Keys inserted in descending byte order: 10, 9, …, 1
    let initial: Vec<(Bytes, Bytes)> = (1u8..=10u8)
        .rev()
        .map(|i| (key(i), val(i, 8)))
        .collect();
    let op = Operation::Lookup(key(0x05));
    generate_fixture(
        "all-right-spine-10leaves",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

// ---- Large balanced trees ----

/// 100-leaf balanced tree; op = Lookup of a key in the middle.
/// Tests depth traversal on a moderately large tree.
fn balanced_100leaves() -> Result<AvlFixture> {
    let initial: Vec<(Bytes, Bytes)> = (1u8..=100u8)
        .map(|i| (key(i), val(i, 8)))
        .collect();
    let op = Operation::Lookup(key(0x32)); // key 50
    generate_fixture(
        "balanced-100leaves",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// 1000-leaf balanced tree; op = Insert of a new key.
/// Stress-tests both proof generation and TS verifier at significant depth.
///
/// Keys: [hi, lo, 0, …, 0] for (hi, lo) in (0x01, 0x00)..(0x03, 0xE7),
/// covering 1000 keys safely below the [0xFF; 32] sentinel.
fn balanced_1000leaves() -> Result<AvlFixture> {
    let mut initial: Vec<(Bytes, Bytes)> = Vec::with_capacity(1000);
    let mut count = 0u32;
    'outer: for hi in 0x01u8..=0x04u8 {
        for lo in 0x00u8..=0xFFu8 {
            if count >= 1000 {
                break 'outer;
            }
            initial.push((key2(hi, lo), val(lo, 8)));
            count += 1;
        }
    }
    assert_eq!(initial.len(), 1000);
    // Insert a new key outside the built range
    let op = Operation::Insert(KeyValue {
        key: key2(0x05, 0x00),
        value: val(0x42, 8),
    });
    generate_fixture(
        "balanced-1000leaves",
        32,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

// ---- All-deletes from 10-leaf tree ----

/// Start with a 10-leaf tree; remove all 10 leaves one by one in a single
/// batch.  After all removals the tree contains only sentinels (digest matches
/// the Rust prover's post-remove digest).
fn all_deletes_from_balanced_10() -> Result<AvlFixture> {
    let initial: Vec<(Bytes, Bytes)> = (1u8..=10u8)
        .map(|i| (key(i), val(i, 8)))
        .collect();
    let ops: Vec<Operation> = (1u8..=10u8)
        .map(|i| Operation::Remove(key(i)))
        .collect();
    generate_fixture(
        "all-deletes-from-balanced-10",
        32,
        None,
        &initial,
        ops.clone(),
        ops,
        false,
    )
}

// ---- UpdateLongBy i64 boundary cases ----

/// UpdateLongBy near i64::MAX.
/// Pre-state: key 0x01 = i64::MAX - 1
/// delta = +1  →  new value = i64::MAX  (valid — no overflow, no removal)
/// This exercises the largest representable positive result.
fn update_long_by_i64_max_boundary() -> Result<AvlFixture> {
    let initial = vec![(key(0x01), val_i64(i64::MAX - 1))];
    let op = Operation::UpdateLongBy(KeyDelta {
        key: key(0x01),
        delta: 1,
    });
    generate_fixture(
        "update-long-by-i64-max-boundary",
        32,
        Some(8),
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// UpdateLongBy that would cross zero into negative → rejected.
/// Pre-state: key 0x01 = i64(5)
/// delta = -10  →  new value = -5  →  verifier must reject.
/// Prover uses Lookup(0x01) to build a valid proof for the key's path;
/// fixture records UpdateLongBy(0x01, -10) which the verifier rejects.
fn update_long_by_negative_result_fail() -> Result<AvlFixture> {
    let initial = vec![(key(0x01), val_i64(5))];
    let prover_op = Operation::Lookup(key(0x01));
    let fixture_op = Operation::UpdateLongBy(KeyDelta {
        key: key(0x01),
        delta: -10,
    });
    generate_fixture(
        "update-long-by-negative-result-fail",
        32,
        Some(8),
        &initial,
        vec![prover_op],
        vec![fixture_op],
        true, // expects rejection
    )
}

// ---- Max-depth note ----
// AVL+ trees are self-balancing; the maximum height for N leaves is
// O(1.44 log₂ N).  For 1000 leaves this is ~14 levels — well within any
// practical limit.  No explicit `max-depth-tree` fixture is needed beyond
// `balanced-1000leaves` which already stresses depth; a standalone fixture
// would duplicate that coverage without adding new information.

// ---------------------------------------------------------------------------
// Config-variance fixtures (T23)
// ---------------------------------------------------------------------------

/// Fixed valueLengthOpt = 8 bytes: insert on a 3-leaf tree.
/// Confirms the verifier handles fixed-length values (as opposed to the
/// variable-length path most other fixtures exercise).
fn config_variance_value_length_fixed_8() -> Result<AvlFixture> {
    let initial = three_leaves(Some(8));
    let op = Operation::Insert(KeyValue {
        key: key(0x10),
        value: val(0x10, 8),
    });
    generate_fixture(
        "config-variance-value-length-fixed-8",
        32,
        Some(8),
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// Build a 3-leaf initial tree with 1-byte keys.
/// 0x00 = negative-infinity sentinel, 0xFF = positive-infinity sentinel.
/// Safe keys: 0x01, 0x02, 0x03.  Insert 0x04.
fn key1(byte: u8) -> Bytes {
    Bytes::from(vec![byte; 1])
}

fn config_variance_keylength_1_insert() -> Result<AvlFixture> {
    let initial: Vec<(Bytes, Bytes)> = vec![
        (key1(0x01), val(0x01, 8)),
        (key1(0x02), val(0x02, 8)),
        (key1(0x03), val(0x03, 8)),
    ];
    let op = Operation::Insert(KeyValue {
        key: key1(0x04),
        value: val(0x04, 8),
    });
    generate_fixture(
        "config-variance-keylength-1-insert",
        1,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// Build a 3-leaf initial tree with 8-byte keys.
/// Use well-separated keys to avoid the positive-infinity sentinel (all-0xFF).
fn key8(byte: u8) -> Bytes {
    Bytes::from(vec![byte; 8])
}

fn config_variance_keylength_8_lookup() -> Result<AvlFixture> {
    let initial: Vec<(Bytes, Bytes)> = vec![
        (key8(0x01), val(0x01, 8)),
        (key8(0x02), val(0x02, 8)),
        (key8(0x03), val(0x03, 8)),
    ];
    let op = Operation::Lookup(key8(0x02));
    generate_fixture(
        "config-variance-keylength-8-lookup",
        8,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

fn config_variance_keylength_8_insert() -> Result<AvlFixture> {
    let initial: Vec<(Bytes, Bytes)> = vec![
        (key8(0x01), val(0x01, 8)),
        (key8(0x02), val(0x02, 8)),
        (key8(0x03), val(0x03, 8)),
    ];
    let op = Operation::Insert(KeyValue {
        key: key8(0x10),
        value: val(0x10, 8),
    });
    generate_fixture(
        "config-variance-keylength-8-insert",
        8,
        None,
        &initial,
        vec![op.clone()],
        vec![op],
        false,
    )
}

/// maxNumOperations = 1 with exactly 1 op — success: DoS guard passes.
fn config_variance_max_ops_exact() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    let op = Operation::Lookup(key(0x02));
    let (mut prover, starting_digest) =
        make_initial_tree(32, None, &initial)?;
    prover.perform_one_operation(&op)?;
    let proof = prover.generate_proof();
    let prover_new_digest = prover.digest().expect("post-op digest");

    // Verifier with tight maxNumOperations=1 — should succeed.
    let mut verifier = BatchAVLVerifier::new(
        &starting_digest,
        &proof,
        AVLTree::new(make_resolver(), 32, None),
        Some(1),
        Some(0),
    )?;
    let r = verifier.perform_one_operation(&op)?;
    let verifier_new_digest = verifier.digest().expect("verifier post-op digest");
    assert_eq!(prover_new_digest, verifier_new_digest, "digest mismatch");

    Ok(AvlFixture {
        name: "config-variance-max-ops-exact".to_string(),
        starting_digest_hex: hex::encode(&starting_digest),
        proof_hex: hex::encode(&proof),
        config: AvlConfig {
            key_length: 32,
            value_length_opt: None,
            max_num_operations: Some(1),
            max_deletes: Some(0),
        },
        operations: vec![op_to_json(&op)],
        expected_new_digest_hex: Some(hex::encode(&prover_new_digest)),
        expected_results_hex: vec![r.as_ref().map(|v| hex::encode(v))],
    })
}

/// maxNumOperations=2, maxDeletes=1 with 1 insert + 1 remove — success.
/// Exercises both bounds simultaneously.
fn config_variance_max_ops_mixed_bounds() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    let ops = vec![
        Operation::Insert(KeyValue { key: key(0x10), value: val(0x10, 8) }),
        Operation::Remove(key(0x01)),
    ];
    generate_fixture(
        "config-variance-max-ops-mixed-bounds",
        32,
        None,
        &initial,
        ops.clone(),
        ops,
        false,
    )
}

// ---------------------------------------------------------------------------
// Adverse (intentional rejection) fixtures (T23)
// ---------------------------------------------------------------------------

/// "Truncated" proof: a single END_OF_TREE byte (0x04) with no tree content
/// before it.  The Rust reconstruct_tree completes the post-order loop
/// immediately (empty stack), then `ensure!(stack.len() == 1)` fails → Err.
///
/// The TS verifier's parseProofPackedTree will reach the `stack.length !== 1`
/// check at the end and return `{ ok: false, reason: 'proof-malformed' }`;
/// verifyAvlBatch therefore returns null.
///
/// We obtain the starting_digest from a real 3-leaf tree so it's the right
/// length (33 bytes); the proof itself is just [0x04].
fn adverse_truncated_proof() -> Result<AvlFixture> {
    // Obtain a valid 33-byte starting digest from a real 3-leaf tree.
    let initial = three_leaves(None);
    // make_initial_tree returns the digest AFTER all initial inserts, which is
    // the stable "starting point" for any operation on this tree.
    let (_, starting_digest) = make_initial_tree(32, None, &initial)?;

    // The adversarial proof is just [END_OF_TREE = 0x04].
    let minimal_proof = Bytes::from(vec![0x04u8]);

    // Rust verifier must reject: empty stack → ensure!(stack.len() == 1) fails.
    let result = BatchAVLVerifier::new(
        &starting_digest,
        &minimal_proof,
        AVLTree::new(make_resolver(), 32, None),
        Some(1),
        Some(0),
    );
    assert!(
        result.is_err(),
        "adverse-truncated-proof: expected Rust verifier to reject minimal proof but it accepted"
    );

    // The fixture op is a Lookup — simple and harmless; the verifier never
    // reaches the operation because tree reconstruction fails first.
    let op = Operation::Lookup(key(0x02));

    Ok(AvlFixture {
        name: "adverse-truncated-proof".to_string(),
        starting_digest_hex: hex::encode(&starting_digest),
        proof_hex: hex::encode(&minimal_proof),
        config: AvlConfig {
            key_length: 32,
            value_length_opt: None,
            max_num_operations: Some(1),
            max_deletes: Some(0),
        },
        operations: vec![op_to_json(&op)],
        expected_new_digest_hex: None,
        expected_results_hex: vec![None],
    })
}

/// Correct proof but wrong starting digest.
///
/// Strategy: take the real 33-byte starting digest, flip every byte in the
/// 32-byte root-label portion (bytes 0..32), and keep the height byte
/// (byte 32) unchanged.  The height byte must be preserved so that the Rust
/// verifier can parse the proof without OOB panics; only the root-label
/// comparison at the end of reconstruct_tree will fail → Err.
///
/// Rust-side verification: `BatchAVLVerifier::new` returns Err because the
/// reconstructed root's label does not match the flipped root-label bytes.
fn adverse_swapped_starting_digest() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    let op = Operation::Lookup(key(0x02));
    let (mut prover, real_starting_digest) =
        make_initial_tree(32, None, &initial)?;
    prover.perform_one_operation(&op)?;
    let proof = prover.generate_proof();

    // Build the wrong digest: flip all 32 root-label bytes, keep height byte.
    let mut wrong_digest_vec: Vec<u8> = real_starting_digest.to_vec();
    for b in &mut wrong_digest_vec[..32] {
        *b = !*b;
    }
    let wrong_digest = Bytes::from(wrong_digest_vec);

    // Rust verifier must reject: reconstructed root doesn't match the flipped label.
    let result = BatchAVLVerifier::new(
        &wrong_digest,
        &proof,
        AVLTree::new(make_resolver(), 32, None),
        Some(1),
        Some(0),
    );
    assert!(
        result.is_err(),
        "adverse-swapped-starting-digest: expected Rust verifier to reject digest mismatch but it accepted"
    );

    Ok(AvlFixture {
        name: "adverse-swapped-starting-digest".to_string(),
        starting_digest_hex: hex::encode(&wrong_digest),
        proof_hex: hex::encode(&proof),
        config: AvlConfig {
            key_length: 32,
            value_length_opt: None,
            max_num_operations: Some(1),
            max_deletes: Some(0),
        },
        operations: vec![op_to_json(&op)],
        expected_new_digest_hex: None,
        expected_results_hex: vec![None],
    })
}

/// Proof generated with keyLength=32, but the fixture records keyLength=16.
///
/// The verifier will misread leaf keys (reading 16 bytes instead of 32 for each
/// key and nextLeafKey field in the packed tree), producing a garbled tree whose
/// root label cannot match the starting digest.
///
/// Rust-side verification: the Rust verifier either returns Err (via ensure!
/// macros) or panics (via OOB slice index) when given mismatched keyLength. We
/// use catch_unwind to treat panics as "rejected" — either outcome confirms the
/// verifier does not silently accept the mismatched input.
///
/// The TS verifier's bounds-checked reader returns proof-truncated or
/// digest-mismatch cleanly (no panic).
fn adverse_mismatched_config_keylength() -> Result<AvlFixture> {
    // Build valid proof with keyLength=32.
    let initial = three_leaves(None);
    let op = Operation::Lookup(key(0x02));
    let (mut prover, starting_digest) =
        make_initial_tree(32, None, &initial)?;
    prover.perform_one_operation(&op)?;
    let proof = prover.generate_proof();

    // Rust verifier with keyLength=16 must reject (Err or panic — both are
    // non-acceptance).  We capture owned copies for the closure.
    let sd_clone = starting_digest.clone();
    let proof_clone = proof.clone();
    let rejected = panic::catch_unwind(panic::AssertUnwindSafe(|| {
        BatchAVLVerifier::new(
            &sd_clone,
            &proof_clone,
            AVLTree::new(make_resolver(), 16, None), // wrong keyLength
            Some(1),
            Some(0),
        ).is_err()
    }));
    // rejected = Ok(true)  → verifier returned Err
    // rejected = Ok(false) → verifier accepted — this must not happen
    // rejected = Err(_)    → verifier panicked — also means it rejected
    assert!(
        rejected.unwrap_or(true), // panic counts as rejection
        "adverse-mismatched-config-keylength: Rust verifier accepted mismatched keyLength — unexpected"
    );

    // The fixture operation must use a 16-byte key to match the advertised
    // config.keyLength=16 (otherwise the TS pre-flight throws AvlVerifyError
    // as a programmer-error, not a verification failure).  Use a 16-byte
    // all-0x02 key — arbitrary, since the proof reconstruction fails first.
    let op16 = OpJson::Lookup { key_hex: hex::encode(vec![0x02u8; 16]) };

    Ok(AvlFixture {
        name: "adverse-mismatched-config-keylength".to_string(),
        starting_digest_hex: hex::encode(&starting_digest),
        proof_hex: hex::encode(&proof),
        config: AvlConfig {
            key_length: 16,        // mismatched: proof uses 32-byte keys
            value_length_opt: None,
            max_num_operations: Some(1),
            max_deletes: Some(0),
        },
        operations: vec![op16],
        expected_new_digest_hex: None,
        expected_results_hex: vec![None],
    })
}

/// A legitimate 3-leaf tree proof presented with `maxNumOperations=0` and
/// `maxDeletes=0`.
///
/// With maxNumOps=0, the KMZ17 Appendix B bound becomes:
///   realNumOps = 0, logNumOps = 0
///   temp = 1 + max(height, 0)
///   hnew = temp + temp/2
///   realMaxDeletes = 0
///   max_nodes = (0 + 0) * (2*height+1) + 0*hnew + 1 = 1
///
/// Any real proof contains at least 2 nodes (leaf for the target key + one
/// sentinel), so the guard fires on the second node → `ensure!` returns Err.
///
/// The fixture itself uses a Lookup on the 3-leaf tree; the proof is valid but
/// the stated `maxNumOperations=0` means the verifier must reject it as
/// exceeding the node budget.
fn adverse_malicious_extra_nodes() -> Result<AvlFixture> {
    let initial = three_leaves(None);
    let op = Operation::Lookup(key(0x02));
    let (mut prover, starting_digest) =
        make_initial_tree(32, None, &initial)?;
    prover.perform_one_operation(&op)?;
    let proof = prover.generate_proof();

    // Rust verifier: maxNumOperations=0, maxDeletes=0 → max_nodes=1.
    // The proof contains more than 1 node → ensure!(num_nodes <= max_nodes) fails.
    let result = BatchAVLVerifier::new(
        &starting_digest,
        &proof,
        AVLTree::new(make_resolver(), 32, None),
        Some(0),  // 0 operations allowed → max_nodes = 1
        Some(0),
    );
    assert!(
        result.is_err(),
        "adverse-malicious-extra-nodes: expected Rust verifier to reject excess nodes \
         with maxNumOperations=0, but it accepted"
    );

    Ok(AvlFixture {
        name: "adverse-malicious-extra-nodes".to_string(),
        starting_digest_hex: hex::encode(&starting_digest),
        proof_hex: hex::encode(&proof),
        config: AvlConfig {
            key_length: 32,
            value_length_opt: None,
            max_num_operations: Some(0),  // 0 operations → max_nodes=1, proof is rejected
            max_deletes: Some(0),
        },
        operations: vec![op_to_json(&op)],
        expected_new_digest_hex: None,
        expected_results_hex: vec![None],
    })
}

// ---------------------------------------------------------------------------
// Partial-success fixture (Phase 2h-b Task A1.6)
// ---------------------------------------------------------------------------

/// 5-op Insert batch where op 3 fails (key-already-exists), exercising
/// `verifyAvlBatchPartial`'s "stop at first failure, return digest after
/// completed ops" path.
///
/// Scenario:
///   - Starting tree contains `K_existing` (a single 32-byte key).
///   - Operations: [Insert(K1), Insert(K2), Insert(K_existing), Insert(K3),
///     Insert(K4)] (5 ops; op 3 fails because the key is already in the
///     tree).
///   - Expected: `opsCompleted == 2` (ops 1 and 2 succeeded; op 3 attempts
///     to insert a duplicate and the verifier rejects);
///     `expected_digest_after_2_ops_hex` = the digest after only ops 1 + 2.
///
/// Proof construction: the prover can't actually run Insert(K_existing)
/// (it would error in the prover too). Instead we use `Lookup(K_existing)`
/// on the prover for op 3's proof segment — this captures the path to
/// K_existing so the verifier can traverse to the leaf and fail the
/// duplicate-insert check there. Ops 4 and 5 are recorded in the operations
/// list but the verifier never reaches them (it stops at op 3 failure).
fn partial_insert_fail_at_3_of_5() -> Result<PartialFixture> {
    let key_length = 32;
    let value_length_opt: Option<usize> = None;

    let k_existing = key(0xAA);
    let k1 = key(0x10);
    let k2 = key(0x20);
    let k3 = key(0x30);
    let k4 = key(0x40);
    let v_existing = val(0xAA, 8);
    let v1 = val(0x11, 8);
    let v2 = val(0x22, 8);
    let v3 = val(0x33, 8);
    let v4 = val(0x44, 8);

    let initial_kvs = vec![(k_existing.clone(), v_existing.clone())];

    // Build prover, pre-populate with K_existing, capture starting digest.
    let (mut prover, starting_digest) =
        make_initial_tree(key_length, value_length_opt, &initial_kvs)?;

    // Prover ops: Insert(K1), Insert(K2) succeed; Lookup(K_existing) captures
    // the path for op 3's verifier-side replay. Ops 4 and 5 are NOT applied
    // to the prover — the verifier stops at op 3 failure under the
    // partial-success contract and never replays them.
    prover.perform_one_operation(&Operation::Insert(KeyValue {
        key: k1.clone(),
        value: v1.clone(),
    }))?;
    prover.perform_one_operation(&Operation::Insert(KeyValue {
        key: k2.clone(),
        value: v2.clone(),
    }))?;
    prover.perform_one_operation(&Operation::Lookup(k_existing.clone()))?;

    let proof = prover.generate_proof();

    // Recorded operations list (what the verifier sees). Op 3 is the
    // duplicate-key insert that must fail.
    let fixture_ops: Vec<OpJson> = vec![
        op_to_json(&Operation::Insert(KeyValue {
            key: k1.clone(),
            value: v1.clone(),
        })),
        op_to_json(&Operation::Insert(KeyValue {
            key: k2.clone(),
            value: v2.clone(),
        })),
        op_to_json(&Operation::Insert(KeyValue {
            key: k_existing.clone(),
            value: v_existing.clone(),
        })),
        op_to_json(&Operation::Insert(KeyValue {
            key: k3.clone(),
            value: v3.clone(),
        })),
        op_to_json(&Operation::Insert(KeyValue {
            key: k4.clone(),
            value: v4.clone(),
        })),
    ];

    // Compute the expected digest after the first 2 ops by replaying through
    // a fresh BatchAVLVerifier and capturing digest() mid-loop (after ops 1+2,
    // before attempting op 3). The verifier is the canonical source of truth
    // for what `verifyAvlBatchPartial` should produce.
    //
    // Verifier needs max_num_operations large enough to cover all 5 recorded
    // ops (the verifier doesn't know the partial contract; it's just doing
    // node-budget computation for the proof shape). Use 5 to match the proof
    // we generated; 0 deletes since all ops are Inserts.
    let mut verifier = BatchAVLVerifier::new(
        &starting_digest,
        &proof,
        AVLTree::new(make_resolver(), key_length, value_length_opt),
        Some(5),
        Some(0),
    )?;
    verifier
        .perform_one_operation(&Operation::Insert(KeyValue {
            key: k1.clone(),
            value: v1.clone(),
        }))?;
    verifier
        .perform_one_operation(&Operation::Insert(KeyValue {
            key: k2.clone(),
            value: v2.clone(),
        }))?;
    let digest_after_2_ops = verifier
        .digest()
        .expect("verifier digest after 2 successful inserts");

    // Sanity-check: the third op (Insert duplicate) must fail on the verifier.
    let op3_result = verifier.perform_one_operation(&Operation::Insert(KeyValue {
        key: k_existing.clone(),
        value: v_existing.clone(),
    }));
    anyhow::ensure!(
        op3_result.is_err(),
        "partial_insert_fail_at_3_of_5: op 3 (Insert of existing key) was \
         expected to fail on the verifier but succeeded"
    );

    Ok(PartialFixture {
        description: "insert 5 entries, op 3 fails (key-already-exists)".to_string(),
        starting_digest_hex: hex::encode(&starting_digest),
        proof_hex: hex::encode(&proof),
        config: AvlConfig {
            key_length,
            value_length_opt,
            max_num_operations: Some(5),
            max_deletes: Some(0),
        },
        operations: fixture_ops,
        expected_ops_completed: 2,
        expected_digest_after_2_ops_hex: hex::encode(&digest_after_2_ops),
    })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run() -> Result<()> {
    // --- Original T8 fixture (kept for T9 proof-decode test compatibility) ---
    write_fixture("single-leaf-insert", &single_leaf_insert()?)?;

    // --- Lookup ---
    write_fixture("lookup-3leaves-present", &lookup_3leaves_present()?)?;
    write_fixture("lookup-3leaves-absent", &lookup_3leaves_absent()?)?;

    // --- Insert ---
    write_fixture("insert-3leaves", &insert_3leaves()?)?;
    write_fixture("insert-100leaves", &insert_100leaves()?)?;

    // --- Update ---
    write_fixture("update-3leaves-present", &update_3leaves_present()?)?;
    write_fixture("update-3leaves-absent-fail", &update_3leaves_absent_fail()?)?;

    // --- InsertOrUpdate ---
    write_fixture(
        "insert-or-update-3leaves-absent",
        &insert_or_update_3leaves_absent()?,
    )?;
    write_fixture(
        "insert-or-update-3leaves-present",
        &insert_or_update_3leaves_present()?,
    )?;

    // --- UpdateLongBy ---
    write_fixture(
        "update-long-by-positive-no-remove",
        &update_long_by_positive_no_remove()?,
    )?;
    write_fixture(
        "update-long-by-to-zero-remove",
        &update_long_by_positive_to_zero_remove()?,
    )?;
    write_fixture(
        "update-long-by-negative-delta-remove",
        &update_long_by_negative_delta_remove()?,
    )?;
    write_fixture(
        "update-long-by-negative-absent-fail",
        &update_long_by_negative_absent_fail()?,
    )?;

    // --- Remove ---
    write_fixture("remove-3leaves-present", &remove_3leaves_present()?)?;
    write_fixture("remove-3leaves-absent-fail", &remove_3leaves_absent_fail()?)?;

    // --- RemoveIfExists ---
    write_fixture(
        "remove-if-exists-3leaves-present",
        &remove_if_exists_3leaves_present()?,
    )?;
    write_fixture(
        "remove-if-exists-3leaves-absent-noop",
        &remove_if_exists_3leaves_absent_noop()?,
    )?;

    // --- UnknownModification ---
    write_fixture("unknown-mod-3leaves-present", &unknown_mod_3leaves_present()?)?;
    write_fixture("unknown-mod-3leaves-absent", &unknown_mod_3leaves_absent()?)?;

    // --- Multi-op batches (T21) ---
    write_fixture("batch-0ops", &batch_0ops()?)?;
    write_fixture("batch-2ops-insert-then-lookup", &batch_2ops_insert_then_lookup()?)?;
    write_fixture("batch-2ops-insert-then-update", &batch_2ops_insert_then_update()?)?;
    write_fixture("batch-2ops-insert-then-remove", &batch_2ops_insert_then_remove()?)?;
    write_fixture("batch-16ops-mixed", &batch_16ops_mixed()?)?;
    write_fixture("batch-256ops-inserts", &batch_256ops_inserts()?)?;
    write_fixture("batch-stress-mixed-100", &batch_stress_mixed_100()?)?;

    // --- Edge cases (T22) ---
    // Empty tree
    write_fixture("empty-tree-lookup", &empty_tree_lookup()?)?;
    // Single-leaf tree, one fixture per Operation variant
    write_fixture("single-leaf-tree-lookup", &single_leaf_tree_lookup()?)?;
    write_fixture("single-leaf-tree-insert", &single_leaf_tree_insert()?)?;
    write_fixture("single-leaf-tree-update", &single_leaf_tree_update()?)?;
    write_fixture("single-leaf-tree-insert-or-update", &single_leaf_tree_insert_or_update()?)?;
    write_fixture("single-leaf-tree-remove", &single_leaf_tree_remove()?)?;
    write_fixture("single-leaf-tree-remove-if-exists", &single_leaf_tree_remove_if_exists()?)?;
    // Skewed insertion trees (10 leaves)
    write_fixture("all-left-spine-10leaves", &all_left_spine_10leaves()?)?;
    write_fixture("all-right-spine-10leaves", &all_right_spine_10leaves()?)?;
    // Large balanced trees
    write_fixture("balanced-100leaves", &balanced_100leaves()?)?;
    write_fixture("balanced-1000leaves", &balanced_1000leaves()?)?;
    // All-deletes
    write_fixture("all-deletes-from-balanced-10", &all_deletes_from_balanced_10()?)?;
    // UpdateLongBy i64 boundary cases
    write_fixture("update-long-by-i64-max-boundary", &update_long_by_i64_max_boundary()?)?;
    write_fixture("update-long-by-negative-result-fail", &update_long_by_negative_result_fail()?)?;

    // --- Config-variance fixtures (T23) ---
    write_fixture("config-variance-value-length-fixed-8", &config_variance_value_length_fixed_8()?)?;
    write_fixture("config-variance-keylength-1-insert", &config_variance_keylength_1_insert()?)?;
    write_fixture("config-variance-keylength-8-lookup", &config_variance_keylength_8_lookup()?)?;
    write_fixture("config-variance-keylength-8-insert", &config_variance_keylength_8_insert()?)?;
    write_fixture("config-variance-max-ops-exact", &config_variance_max_ops_exact()?)?;
    write_fixture("config-variance-max-ops-mixed-bounds", &config_variance_max_ops_mixed_bounds()?)?;

    // --- Adverse (intentional rejection) fixtures (T23) ---
    write_fixture("adverse-truncated-proof", &adverse_truncated_proof()?)?;
    write_fixture("adverse-swapped-starting-digest", &adverse_swapped_starting_digest()?)?;
    write_fixture("adverse-mismatched-config-keylength", &adverse_mismatched_config_keylength()?)?;
    write_fixture("adverse-malicious-extra-nodes", &adverse_malicious_extra_nodes()?)?;

    // --- Partial-success fixtures (Phase 2h-b Task A1.6) ---
    // Lives under packages/avltree/test/fixtures/partial/ (separate corpus
    // dir; distinct schema from the main avltree/ all-or-nothing fixtures).
    write_partial_fixture(
        "insert-fail-at-3-of-5",
        &partial_insert_fail_at_3_of_5()?,
    )?;

    Ok(())
}
