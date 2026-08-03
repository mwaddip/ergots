//! removedNodes() conformance vectors for @ergots/avltree Phase D.
//! Emits one JSON per scripted sequence into ERGOTS_FIXTURE_DIR.
//!
//! REGENERATION (this file is preserved in-repo for exactly this):
//!   1. git -C ~/projects/ergo_avltree_rust worktree add --detach <scratch>/avltree-d-vectors 568e7c3
//!   2. cp this file to <worktree>/tests/removed_nodes_vectors.rs
//!   3. cd <worktree> && ERGOTS_FIXTURE_DIR=<ergots-repo>/packages/avltree/test/fixtures/removed-nodes \
//!        cargo test --test removed_nodes_vectors -- --nocapture
//!   4. Run a second time into a scratch dir and diff against committed — must be EMPTY.
//!   5. git -C ~/projects/ergo_avltree_rust worktree remove --force <worktree>
//!   Reference: ergo_avltree_rust @ 568e7c3 (canonical main at generation time).
//! Capture discipline (spec-review F5): removed_nodes() exactly once per
//! cycle, BEFORE generate_proof() — generate_proof clears the buffers as its
//! first statements and repeat calls self-append. Rollback cycles call
//! restore_root() first DELIBERATELY: they pin the cleared-cycle observable
//! (empty set, cycle-start digest).
use blake2::digest::Digest as _;
use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::*;
use ergo_avltree_rust::batch_avl_prover::*;
use ergo_avltree_rust::batch_node::*;
use ergo_avltree_rust::operation::*;
use std::fmt::Write as _;
use std::fs;

mod common;
use common::*;

const KL: usize = 32;

fn dkey(vector: &str, i: usize) -> ADKey {
    // Deterministic 32-byte key strictly inside (all-0, all-ff).
    let mut hasher = Blake2b256::new();
    hasher.update(format!("d-{vector}-{i}"));
    let mut k = hasher.finalize().to_vec();
    k[0] = 1; // clamp away from both infinities
    Bytes::copy_from_slice(&k)
}

fn dval(i: usize) -> ADValue {
    Bytes::copy_from_slice(&(i as u64).to_be_bytes())
}

fn hex(b: &[u8]) -> String {
    base16::encode_lower(b)
}

enum ScriptOp {
    Ins(usize),          // Insert(dkey(v,n), dval(n))
    InsFail(usize),      // Insert on existing key — MUST fail engine-level
    Rem(usize),          // Remove(dkey(v,n))
    Upd(usize, usize),   // Update(dkey(v,n), dval(m))
    UpdLong(usize, i64), // UpdateLongBy(dkey(v,n), delta)
    Look(usize),         // Lookup(dkey(v,n))
}

struct Cycle {
    ops: Vec<ScriptOp>,
    rollback: bool,
}

fn op_json(vector: &str, op: &ScriptOp) -> String {
    match op {
        ScriptOp::Ins(n) | ScriptOp::InsFail(n) => format!(
            r#"{{"tag":"Insert","keyHex":"{}","valueHex":"{}"}}"#,
            hex(&dkey(vector, *n)), hex(&dval(*n))
        ),
        ScriptOp::Rem(n) => format!(
            r#"{{"tag":"Remove","keyHex":"{}"}}"#, hex(&dkey(vector, *n))
        ),
        ScriptOp::Upd(n, m) => format!(
            r#"{{"tag":"Update","keyHex":"{}","valueHex":"{}"}}"#,
            hex(&dkey(vector, *n)), hex(&dval(*m))
        ),
        ScriptOp::UpdLong(n, d) => format!(
            r#"{{"tag":"UpdateLongBy","keyHex":"{}","delta":{}}}"#,
            hex(&dkey(vector, *n)), d
        ),
        ScriptOp::Look(n) => format!(
            r#"{{"tag":"Lookup","keyHex":"{}"}}"#, hex(&dkey(vector, *n))
        ),
    }
}

fn to_operation(vector: &str, op: &ScriptOp) -> Operation {
    match op {
        ScriptOp::Ins(n) | ScriptOp::InsFail(n) => Operation::Insert(KeyValue {
            key: dkey(vector, *n), value: dval(*n),
        }),
        ScriptOp::Rem(n) => Operation::Remove(dkey(vector, *n)),
        ScriptOp::Upd(n, m) => Operation::Update(KeyValue {
            key: dkey(vector, *n), value: dval(*m),
        }),
        ScriptOp::UpdLong(n, d) => Operation::UpdateLongBy(KeyDelta {
            key: dkey(vector, *n), delta: *d,
        }),
        ScriptOp::Look(n) => Operation::Lookup(dkey(vector, *n)),
    }
}

fn run_vector(name: &str, value_length: Option<usize>, cycles: Vec<Cycle>) {
    let mut prover = generate_prover(KL, value_length);
    let mut cycles_json: Vec<String> = Vec::new();

    for cycle in &cycles {
        let saved_root = prover.top_node();
        let saved_height = prover.base.tree.height;
        let mut ops_json: Vec<String> = Vec::new();
        let mut fail_idx: Vec<usize> = Vec::new();

        for (i, sop) in cycle.ops.iter().enumerate() {
            ops_json.push(op_json(name, sop));
            let res = prover.perform_one_operation(&to_operation(name, sop));
            match sop {
                ScriptOp::InsFail(_) => {
                    assert!(res.is_err(), "{name}: op {i} was scripted to fail but succeeded");
                    fail_idx.push(i);
                }
                _ => assert!(res.is_ok(), "{name}: op {i} failed unexpectedly: {res:?}"),
            }
        }

        if cycle.rollback {
            prover.restore_root(saved_root.clone(), saved_height);
        }

        // Capture: exactly once, before generate_proof (F5).
        let mut labels: Vec<String> = prover
            .removed_nodes()
            .iter()
            .map(|n| hex(&n.borrow_mut().label()))
            .collect();
        labels.sort();
        let digest = hex(&prover.digest().unwrap());
        prover.generate_proof();

        let mut c = String::new();
        write!(
            c,
            r#"{{"ops":[{}],"expectFailIdx":[{}],"rollbackToCycleStart":{},"removedLabelsHex":[{}],"digestHex":"{}"}}"#,
            ops_json.join(","),
            fail_idx.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(","),
            cycle.rollback,
            labels.iter().map(|l| format!("\"{l}\"")).collect::<Vec<_>>().join(","),
            digest
        )
        .unwrap();
        cycles_json.push(c);
    }

    let vl = match value_length {
        Some(v) => v.to_string(),
        None => "null".to_string(),
    };
    let json = format!(
        "{{\"name\":\"{name}\",\"config\":{{\"keyLength\":{KL},\"valueLengthOpt\":{vl}}},\"cycles\":[{}]}}\n",
        cycles_json.join(",")
    );
    let dir = std::env::var("ERGOTS_FIXTURE_DIR").expect("set ERGOTS_FIXTURE_DIR");
    fs::write(format!("{dir}/{name}.json"), json).unwrap();
}

#[test]
fn emit_removed_nodes_vectors() {
    use ScriptOp::*;
    run_vector("insert-only", Some(8), vec![
        Cycle { ops: vec![Ins(0), Ins(1), Ins(2), Ins(3), Ins(4)], rollback: false },
    ]);
    run_vector("insert-remove", Some(8), vec![
        Cycle { ops: vec![Ins(0), Ins(1), Ins(2), InsFail(1), Rem(1), Ins(3)], rollback: false },
    ]);
    run_vector("rotation-heavy", None, vec![
        Cycle { ops: (0..32).map(Ins).collect(), rollback: false },
        Cycle { ops: (0..16).map(|i| Rem(i * 2)).collect(), rollback: false },
    ]);
    run_vector("update-ops", Some(8), vec![
        Cycle { ops: vec![Ins(0), Ins(1), Ins(2)], rollback: false },
        Cycle { ops: vec![Upd(0, 7), UpdLong(1, 5), Look(2)], rollback: false },
    ]);
    run_vector("multi-cycle", Some(8), vec![
        Cycle { ops: vec![Ins(0), Ins(1)], rollback: false },
        Cycle { ops: vec![Ins(2), Rem(0)], rollback: false },
        Cycle { ops: vec![Upd(1, 9), Ins(3)], rollback: false },
    ]);
    run_vector("rollback", Some(8), vec![
        Cycle { ops: vec![Ins(0), Ins(1)], rollback: false },
        Cycle { ops: vec![Ins(2), Rem(0)], rollback: true },
    ]);
    run_vector("lookup-only", Some(8), vec![
        Cycle { ops: vec![Ins(0), Ins(1)], rollback: false },
        Cycle { ops: vec![Look(0), Look(1)], rollback: false },
    ]);
}
