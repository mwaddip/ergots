// Public surface of @ergots/avltree.

export {
  verifyAvlBatch,
  verifyAvlBatchPartial,
  verifyAvlLookup,
  type VerifyAvlBatchResult,
  type VerifyAvlBatchPartialResult,
} from './verify.js'
export type { AvlTreeConfig, OperationResult } from './types.js'
export type { Operation } from './operation.js'
export { AvlVerifyError, type AvlVerifyErrorCode } from './errors.js'

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

// Internal types (NOT exported): BatchAvlVerifier, modify/delete helpers,
// rotation primitives, tree-traversal state.
// These are implementation detail and may change without notice.
