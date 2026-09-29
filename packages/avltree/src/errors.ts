/**
 * Eight-variant string union of programmer-error codes.
 * TS-only: Rust uses anyhow::Result throughout (no typed error codes).
 * Each code corresponds to a shape-validation precondition on a public entry
 * point (the verify functions, BatchAVLVerifier, and BatchAVLProver's
 * operations and neighbor lookups).
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
 * verify wrappers (verifyAvlBatch* / verifyAvlLookup), by BatchAVLVerifier,
 * and by BatchAVLProver's operations and neighbor lookups, for invalid shapes
 * in calling code: bad config, wrong digest length, key/value length
 * mismatches, an UpdateLongBy delta outside i64, or (prover only) a key at
 * or beyond a ±inf sentinel. TS-only: Rust uses anyhow::Result.
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
 * Verification-failure reason taxonomy (11 reasons). Tracked by
 * VerifierCore.lastFailReason; public since 0.5.0 through
 * BatchAVLVerifier.getLastFailReason(). Three members are never produced and
 * stay for stability: 'tree-poisoned' (every poisoning path also sets its
 * own reason, and a poisoned verifier keeps it), 'empty-tree' (no
 * assignment site), and 'operation-required-but-not-allowed' (reserved).
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
  // never produced: a poisoned verifier keeps its first reason
  | 'tree-poisoned'
  // never produced: no assignment site
  | 'empty-tree'
  | 'operation-required-but-not-allowed'  // reserved for ABI stability
