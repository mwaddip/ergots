/**
 * Public verifier entry point.
 *
 * `verifyAvlBatch` wraps `BatchAvlVerifier` with:
 *   - shape validation (throws `AvlVerifyError` on programmer errors)
 *   - a clean null-on-failure return for all untrusted-input rejections
 *
 * Per the design spec, this is the primary public surface on v0.1.0.
 * `BatchAvlVerifier` itself is intentionally not exported until the API
 * is promoted in a later version.
 *
 * @see ~/projects/ergo_avltree_rust/src/batch_avl_verifier.rs
 * @see ~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs
 */

import { BatchAvlVerifier } from './batch-verifier.js'
import { AvlVerifyError } from './errors.js'
import type { AvlTreeConfig } from './types.js'
import type { Operation } from './operation.js'

/**
 * Successful batch-verify result.
 *
 * `newDigest` — the 33-byte AVL+ digest after all operations complete.
 * `results`   — per-operation old values: `Uint8Array` when the key was
 *               present before the operation, `null` when absent.
 */
export interface VerifyAvlBatchResult {
  readonly newDigest: Uint8Array
  readonly results: (Uint8Array | null)[]
}

/**
 * Verify an authenticated batch of AVL+ operations against the given proof.
 *
 * Applies each operation in order against the reconstructed AVL+ tree and
 * returns the resulting 33-byte `newDigest` together with per-operation
 * old-values on success.
 *
 * Returns `null` on any verification failure (malformed proof, digest
 * mismatch, precondition violation by an operation, or structural
 * inconsistency). Verification failures are untrusted-input rejections and
 * are intentionally NOT thrown — callers can treat `null` as "proof invalid".
 *
 * Throws `AvlVerifyError` for programmer errors (invalid config, wrong
 * digest length, key/value length mismatches between the config and the
 * supplied operations). These indicate bugs in the calling code, not in the
 * proof data.
 *
 * @param startingDigest  33-byte AVL+ digest before any operations.
 * @param proof           Serialised AD proof bytes (packed post-order tree
 *                        + directions bit-string).
 * @param config          Tree configuration: key length, optional fixed value
 *                        length, and optional DoS bounds.
 * @param operations      Ordered list of operations to apply.
 * @returns               `{ newDigest, results }` on success, `null` on failure.
 * @throws AvlVerifyError on programmer-error inputs.
 */
export function verifyAvlBatch(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): VerifyAvlBatchResult | null {
  // 1. Validate shapes — throw AvlVerifyError on programmer-error inputs.
  validateConfig(config)
  validateStartingDigest(startingDigest)
  for (const op of operations) validateOperationShape(op, config)

  // 2. Construct verifier — proof decoding inside the constructor.
  const v = new BatchAvlVerifier(startingDigest, proof, config)
  if (!v.isValid) return null

  // 3. Apply operations one at a time.
  const results: (Uint8Array | null)[] = []
  for (const op of operations) {
    const r = v.performOneOperation(op)
    if (typeof r === 'object' && r !== null && 'failed' in r) return null
    results.push(r as Uint8Array | null)
  }

  // 4. Compute final digest.
  const newDigest = v.digest()
  if (newDigest === null) return null
  return { newDigest, results }
}

// ---------------------------------------------------------------------------
// Internal validators
// ---------------------------------------------------------------------------

/**
 * Validates AvlTreeConfig fields.
 * Throws AvlVerifyError (code 'invalid-config-key-length',
 * 'invalid-config-value-length', or 'invalid-config-max-ops') for any
 * field that violates its stated constraint.
 */
function validateConfig(config: AvlTreeConfig): void {
  if (config.keyLength <= 0) {
    throw new AvlVerifyError(
      `keyLength must be > 0; got ${config.keyLength}`,
      'invalid-config-key-length',
    )
  }
  if (config.valueLengthOpt !== null && config.valueLengthOpt !== undefined && config.valueLengthOpt < 0) {
    throw new AvlVerifyError(
      `valueLengthOpt must be >= 0 or null; got ${config.valueLengthOpt}`,
      'invalid-config-value-length',
    )
  }
  if (config.maxNumOperations !== undefined && config.maxNumOperations < 0) {
    throw new AvlVerifyError(
      `maxNumOperations must be >= 0; got ${config.maxNumOperations}`,
      'invalid-config-max-ops',
    )
  }
  if (
    config.maxDeletes !== undefined &&
    config.maxNumOperations !== undefined &&
    config.maxDeletes > config.maxNumOperations
  ) {
    throw new AvlVerifyError(
      `maxDeletes (${config.maxDeletes}) must be <= maxNumOperations (${config.maxNumOperations})`,
      'invalid-config-max-ops',
    )
  }
}

/**
 * Validates that startingDigest is exactly 33 bytes (32-byte root label +
 * 1-byte height). Throws AvlVerifyError (code 'invalid-starting-digest-length').
 */
function validateStartingDigest(d: Uint8Array): void {
  if (d.length !== 33) {
    throw new AvlVerifyError(
      `startingDigest must be 33 bytes; got ${d.length}`,
      'invalid-starting-digest-length',
    )
  }
}

/**
 * Validates a single operation's key (and value if applicable) against the
 * config's length constraints.
 * Throws AvlVerifyError (codes 'operation-key-length-mismatch' or
 * 'operation-value-length-mismatch').
 */
function validateOperationShape(op: Operation, config: AvlTreeConfig): void {
  if (op.key.length !== config.keyLength) {
    throw new AvlVerifyError(
      `op ${op.tag}: key.length=${op.key.length} != config.keyLength=${config.keyLength}`,
      'operation-key-length-mismatch',
    )
  }
  if (
    'value' in op &&
    config.valueLengthOpt !== null &&
    config.valueLengthOpt !== undefined &&
    op.value.length !== config.valueLengthOpt
  ) {
    throw new AvlVerifyError(
      `op ${op.tag}: value.length=${op.value.length} != config.valueLengthOpt=${config.valueLengthOpt}`,
      'operation-value-length-mismatch',
    )
  }
}
