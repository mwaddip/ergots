use std::sync::Arc;
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

fn write_fixture(name: &str, fixture: &AvlFixture) -> Result<()> {
    let dir = fixtures_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(fixture)?;
    std::fs::write(&path, json + "\n")?;
    println!("wrote {}", path.display());
    Ok(())
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

    Ok(())
}
