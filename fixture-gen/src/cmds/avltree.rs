use std::sync::Arc;
use anyhow::Result;
use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_avl_verifier::BatchAVLVerifier;
use ergo_avltree_rust::batch_node::{AVLTree, Node, NodeHeader};
use ergo_avltree_rust::operation::{Digest32, KeyValue, Operation};
use serde::Serialize;
use std::path::PathBuf;

/// Fixture shape: deserialized by the TS corpus tests.
#[derive(Serialize)]
struct AvlFixture {
    name: String,
    starting_digest_hex: String,
    proof_hex: String,
    config: AvlConfig,
    operations: Vec<OpJson>,
    expected_new_digest_hex: String,
    expected_results_hex: Vec<Option<String>>,
}

#[derive(Serialize)]
struct AvlConfig {
    key_length: usize,
    value_length_opt: Option<usize>,
    max_num_operations: Option<usize>,
    max_deletes: Option<usize>,
}

#[derive(Serialize)]
#[serde(tag = "tag", rename_all = "PascalCase")]
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
        .unwrap()
        .join("packages/avltree/test/fixtures/avltree")
}

fn write_fixture(name: &str, fixture: &AvlFixture) -> Result<()> {
    std::fs::create_dir_all(fixtures_dir())?;
    let path = fixtures_dir().join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(fixture)?;
    std::fs::write(&path, json + "\n")?;
    println!("wrote {}", path.display());
    Ok(())
}

/// Resolver used by both prover construction and verifier cross-check.
fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// First fixture: Insert a single key into an empty tree.
fn single_leaf_insert() -> Result<AvlFixture> {
    let key_length = 32;
    let value_length_opt = None;
    let mut prover = BatchAVLProver::new(
        AVLTree::new(make_resolver(), key_length, value_length_opt),
        true,
    );
    let starting_digest = prover.digest().expect("empty-tree digest");

    let key = Bytes::from(vec![0x42u8; 32]);
    let value = Bytes::from(vec![0x55u8; 8]);
    let op = Operation::Insert(KeyValue {
        key: key.clone(),
        value: value.clone(),
    });

    let result = prover.perform_one_operation(&op)?;
    let proof = prover.generate_proof();
    let new_digest = prover.digest().expect("post-insert digest");

    // Cross-verify with the Rust verifier so our expected results are authoritative.
    let mut verifier = BatchAVLVerifier::new(
        &starting_digest,
        &proof,
        AVLTree::new(make_resolver(), key_length, value_length_opt),
        Some(1),
        Some(0),
    )?;
    let verifier_result = verifier.perform_one_operation(&op)?;
    let verifier_new_digest = verifier.digest().expect("verifier post-op digest");
    assert_eq!(
        new_digest, verifier_new_digest,
        "prover/verifier digest mismatch"
    );
    assert_eq!(
        result, verifier_result,
        "prover/verifier operation result mismatch"
    );

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
            key_hex: hex::encode(&key),
            value_hex: hex::encode(&value),
        }],
        expected_new_digest_hex: hex::encode(&new_digest),
        expected_results_hex: vec![result.map(|v| hex::encode(&v))],
    })
}

pub fn run() -> Result<()> {
    write_fixture("single-leaf-insert", &single_leaf_insert()?)?;
    Ok(())
}
