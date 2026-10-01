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
export type { NeighborLookup, NeighborLookupResult } from './neighbors.js'

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

// The strict step-by-step verifier (0.6.0): BatchAVLVerifier's surface plus
// isFullyConsumed(). NOT Ergo consensus — see facts/avltree.md. Kept as the
// LAST export on purpose: its modules are then appended after all existing
// code in dist/index.js, which leaves that code's text untouched.
export { StrictBatchAVLVerifier } from './strict-verifier.js'

// Internal (NOT exported): VerifierCore, modify/delete helpers, rotation
// primitives, tree-traversal state, compare-bytes.ts's byte comparator,
// neighbors.ts's neighborLookupOf, strict-verifier.ts's RecordingVerifierCore,
// canonical-proof.ts's matchesCanonicalProof, verify.ts's three validators.
// These are implementation detail and may change without notice.
