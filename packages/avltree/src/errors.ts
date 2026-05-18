/**
 * Programmer-error rejections. See facts/avltree.md § Error model for the
 * full taxonomy. Verification failures (untrusted-input rejection) return
 * null from public wrappers and are NOT thrown — see AvlVerifyFailReason
 * (currently internal, tracked on BatchAvlVerifier.lastFailReason).
 */
export type AvlVerifyErrorCode =
  | 'invalid-config-key-length'
  | 'invalid-config-value-length'
  | 'invalid-config-max-ops'
  | 'invalid-starting-digest-length'
  | 'operation-key-length-mismatch'
  | 'operation-value-length-mismatch'

export class AvlVerifyError extends Error {
  readonly code: AvlVerifyErrorCode
  constructor(code: AvlVerifyErrorCode, message: string) {
    super(message)
    this.name = 'AvlVerifyError'
    this.code = code
  }
}

/**
 * Internal verification-failure reason taxonomy (10 reasons). Tracked by
 * BatchAvlVerifier.lastFailReason but NOT exposed in the public API on v0.1.0.
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
  | 'tree-poisoned'
  | 'empty-tree'
  | 'operation-required-but-not-allowed'  // reserved for ABI stability
