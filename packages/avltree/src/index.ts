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

// Internal types (NOT exported): BatchAvlVerifier, node types,
// modify/delete helpers, rotation primitives, tree-traversal state.
// These are implementation detail and may change without notice.
