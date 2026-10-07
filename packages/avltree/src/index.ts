// Public surface of @ergots/avltree.

export {
  BatchAVLVerifier,
  verifyAvlBatch,
  verifyAvlBatchPartial,
  verifyAvlLookup,
  type VerifyAvlBatchResult,
  type VerifyAvlBatchPartialResult,
} from './verify.js'
export type { AvlTreeConfig, OperationResult } from './types.js'
export type { Operation } from './operation.js'
export { AvlVerifyError, type AvlVerifyErrorCode, type AvlVerifyFailReason } from './errors.js'

export { BatchAVLProver, type ProverOperationResult } from './batch-prover.js'
export { PersistentBatchAVLProver } from './persistent-prover.js'
export type { VersionedAVLStorage } from './versioned-storage.js'

// Node types, constructors, and label computation — exported for
// storage-backend consumers (e.g. DAGsocial) that need to serialize
// and reconstruct AVL+ trees.
export {
  type AvlNode,
  type LeafNode,
  type InternalNode,
  type LabelNode,
  type Balance,
  newLeaf,
  newInternal,
  newLabel,
  label,
} from './node.js'

// Per-node storage codec, byte-identical to ergo_avltree_rust's
// AVLTree::pack / unpack for well-formed input. Storage-layer only — not the
// proof encoding.
export { serializeNode, deserializeNode } from './serialize.js'

// -----------------------------------------------------------------------------
// Extension surface (0.7.0) — hooks a downstream verifier of its own needs to
// subclass the engine or the prover and read the same bits the shipped
// verifiers do. NOT Ergo consensus. See facts/avltree.md § Extension surface
// and API.md.
//
// The surface is additive and the names are stable. Lazy-node access: the
// engine reads a node's `left` / `right` only when descending into or
// labeling that node; an unvisited sibling's `left` / `right` is not read.
// See facts/avltree.md § Lazy-node access invariant and
// test/lazy-node-access.test.ts.
// -----------------------------------------------------------------------------
export { VerifierCore } from './batch-verifier.js'
export type { AvlTreeOpsCallbacks, LeafCallback, KeyMatchesResult } from './avl-tree-ops.js'
export { compareBytes, negInfKey, posInfKey } from './compare-bytes.js'
export { validateConfig, validateOperationShape, validateStartingDigest } from './verify.js'

// Internal (NOT exported): modify/delete helpers, rotation primitives,
// tree-traversal state. These are implementation detail and may change
// without notice.
