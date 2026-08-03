/**
 * Eight-variant string union of programmer-error codes.
 * TS-only: Rust uses anyhow::Result throughout (no typed error codes).
 * Each code corresponds to a shape-validation precondition on a public entry
 * point (verifyAvlBatch / verifyAvlLookup / BatchAVLProver.performOneOperation).
 * See facts/avltree.md § Failure model overview.
 */
export type AvlVerifyErrorCode =
  | 'invalid-config-key-length'
  | 'invalid-config-value-length'
  | 'invalid-config-max-ops'
  | 'invalid-starting-digest-length'
  | 'operation-key-length-mismatch'
  | 'operation-value-length-mismatch'
  | 'operation-delta-out-of-range' // AVL-03: UpdateLongBy.delta outside i64
  | 'operation-key-out-of-bounds' // op key at/beyond a ±inf sentinel (references' entry requires)

/**
 * Programmer-error rejection class. Thrown (never returned) by the public
 * verify wrappers (verifyAvlBatch / verifyAvlLookup) and by
 * BatchAVLProver.performOneOperation, for invalid shapes in calling code:
 * bad config, wrong digest length, or key/value length mismatches. TS-only:
 * Rust uses anyhow::Result.
 */
export class AvlVerifyError extends Error {
  constructor(
    message: string,
    public readonly code: AvlVerifyErrorCode
  ) {
    super(message)
    this.name = 'AvlVerifyError'
  }
}

/**
 * Internal verification-failure reason taxonomy (11 reasons). Tracked by
 * BatchAvlVerifier.lastFailReason but NOT exposed in the public API on v0.4.0.
 * Promoted to a getLastFailReason() method if/when the internal class is
 * promoted to public surface (deferred per design spec's option-3 decision).
 */
export type AvlVerifyFailReason =
  | 'proof-truncated'
  | 'proof-malformed'
  | 'digest-mismatch'
  | 'directions-exhausted'
  | 'leaf-key-out-of-order'
  | 'max-nodes-exceeded'
  | 'operation-precondition-failed'
  | 'key-out-of-bounds'  // op key not strictly inside the ±inf sentinels (references' entry requires)
  | 'tree-poisoned'
  | 'empty-tree'
  | 'operation-required-but-not-allowed'  // reserved for ABI stability
