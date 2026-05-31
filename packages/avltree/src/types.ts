/**
 * Internal byte-array aliases. Document intent; the TS type is just Uint8Array.
 * Mirrors operation.rs's ADKey / ADValue type aliases.
 */
export type ADKey = Uint8Array
export type ADValue = Uint8Array

/** Public verifier-input config. Mirrors AVLTree's structural fields in ergo_avltree_rust. */
export interface AvlTreeConfig {
  /** Bytes per key. Must be > 0. */
  keyLength: number
  /** Bytes per value; null = variable length per leaf. */
  valueLengthOpt: number | null
  /** DoS guard — max operations across this batch. */
  maxNumOperations?: number
  /** Max deletions across this batch. Defaults to maxNumOperations. */
  maxDeletes?: number
}

/** Per-operation result. Returned in VerifyAvlBatchResult.results. */
export type OperationResult = Uint8Array | null  // null = key was absent before op
