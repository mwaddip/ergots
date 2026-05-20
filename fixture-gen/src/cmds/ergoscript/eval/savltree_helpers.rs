//! Shared helpers for the SAvlTree fixture-gen modules.
//!
//! Consolidates the `make_resolver` closure-factory previously duplicated
//! across 8 sibling modules (savltree_insert / update / get / get_many /
//! contains / remove / partial_success / insert_or_update). Promoted in
//! Phase 2h-e per
//! `docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md`.

use std::sync::Arc;

use ergo_avltree_rust::batch_node::{Node, NodeHeader};
use ergo_avltree_rust::operation::Digest32;

/// Factory for the `BatchAVLProver`'s node-resolver. Returns a closure that
/// produces `Node::LabelOnly` from any 32-byte digest input.
pub(super) fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}
