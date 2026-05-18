// Public surface of @mwaddip/ergots-avltree.

export { verifyAvlBatch, verifyAvlLookup, type VerifyAvlBatchResult } from './verify.js'
export type { AvlTreeConfig, OperationResult } from './types.js'
export type { Operation } from './operation.js'
export { AvlVerifyError, type AvlVerifyErrorCode } from './errors.js'

// Internal types (NOT exported): AvlVerifyFailReason, BatchAvlVerifier, node types,
// modify/delete helpers, rotation primitives, tree-traversal state.
// These are implementation detail and may change without notice.
