/**
 * Internal byte-array aliases. Document intent; the TS type is just Uint8Array.
 * Mirrors operation.rs's ADKey / ADValue / ADDigest type aliases.
 */
export type ADKey = Uint8Array
export type ADValue = Uint8Array
export type ADDigest = Uint8Array         // 33 bytes: 32-byte root label + 1-byte tree height

/** NodeId is the conceptual identifier of a node; in TS we hold direct object refs. */
export type NodeId = Node | null
/** Forward-decl for circular ref. Defined in node.ts. */
export type Node = unknown

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
