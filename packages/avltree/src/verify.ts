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
 * Partial-success result from `verifyAvlBatchPartial`.
 *
 * `newDigest`    — the 33-byte AVL+ digest reflecting the verifier state AFTER
 *                  the last successful operation. Equals the final digest when
 *                  every op succeeded; equals the snapshot taken before the
 *                  failing op when partial.
 * `results`      — per-operation old values for SUCCESSFUL operations only;
 *                  length === opsCompleted.
 * `opsCompleted` — count of operations applied before any failure. Equals
 *                  `operations.length` on full success.
 */
export interface VerifyAvlBatchPartialResult {
  readonly newDigest: Uint8Array
  readonly results: (Uint8Array | null)[]
  readonly opsCompleted: number
}

/**
 * Verify an authenticated batch of AVL+ operations against the given proof,
 * returning a partial-success result that reflects the state up to (and not
 * including) the first failing operation.
 *
 * Semantics:
 *  - Returns `null` only when the verifier itself fails to anchor: proof
 *    decode failure or digest mismatch in the constructor. There is no
 *    partial state to report in that case.
 *  - On per-operation failure, iteration stops immediately and the returned
 *    `newDigest` is the digest taken BEFORE the failing op (i.e., after the
 *    last successful op). `opsCompleted` equals the count of successful ops
 *    (zero-indexed position of the failed op).
 *  - On full success, `opsCompleted === operations.length` and `newDigest`
 *    equals the verifier's final digest.
 *
 * Why a pre-op digest snapshot is necessary: sigma-rust's `BatchAVLVerifier`
 * (and the TS port) poisons `root = null` on op failure, after which `digest()`
 * returns `null`. To surface the state AFTER the last successful op, we
 * snapshot `v.digest()` before each op and return the most recent snapshot
 * when an op fails.
 *
 * Throws `AvlVerifyError` for programmer errors (invalid config, wrong digest
 * length, key/value length mismatches). Same shape validation as
 * `verifyAvlBatch`; that function is a thin wrapper over this one.
 *
 * @see `verifyAvlBatch` for the v0.1.0 all-or-nothing semantics built on top.
 */
export function verifyAvlBatchPartial(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): VerifyAvlBatchPartialResult | null {
  // 1. Validate shapes — throw AvlVerifyError on programmer-error inputs.
  validateConfig(config)
  validateStartingDigest(startingDigest)
  for (const op of operations) validateOperationShape(op, config)

  // 2. Construct verifier — proof decoding inside the constructor.
  const v = new BatchAvlVerifier(startingDigest, proof, config)
  if (!v.isValid) return null

  // Initial digest snapshot — the state before any op. Used when op 0 fails
  // (opsCompleted === 0, newDigest === startingDigest).
  let lastGoodDigest = v.digest()
  // Constructor success implies root !== null, so digest() returns non-null.
  // Guard for the type-checker; promote to a verification failure if ever
  // hit (would indicate a logic bug in BatchAvlVerifier).
  if (lastGoodDigest === null) return null

  // 3. Apply operations one at a time, snapshotting digest BEFORE each op so
  // we can return the post-last-successful-op state on failure (the verifier
  // poisons root = null on per-op failure, which would otherwise lose this).
  const results: (Uint8Array | null)[] = []
  let opsCompleted = 0
  for (const op of operations) {
    const r = v.performOneOperation(op)
    if (typeof r === 'object' && r !== null && 'failed' in r) {
      // Failure: lastGoodDigest already reflects the state from before this op.
      return { newDigest: lastGoodDigest, results, opsCompleted }
    }
    results.push(r as Uint8Array | null)
    opsCompleted++
    // Refresh the snapshot — current state is now "after this op".
    const next = v.digest()
    // Same guard as above: success path implies non-null digest. Defensive.
    if (next === null) return null
    lastGoodDigest = next
  }

  // 4. All operations succeeded — lastGoodDigest is the final post-batch digest.
  return { newDigest: lastGoodDigest, results, opsCompleted }
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
 * All-or-nothing semantics: any per-op failure collapses the entire batch
 * to `null`, even if earlier ops succeeded. For partial-success semantics
 * (state-after-last-successful-op + opsCompleted), use
 * `verifyAvlBatchPartial` directly — this function is a thin wrapper that
 * discards the partial state.
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
  const partial = verifyAvlBatchPartial(startingDigest, proof, config, operations)
  if (partial === null) return null
  if (partial.opsCompleted < operations.length) return null
  return { newDigest: partial.newDigest, results: partial.results }
}

/**
 * Thin convenience wrapper over verifyAvlBatch for single-key reads.
 * Returns:
 *   - { value: Uint8Array } if the key was present
 *   - { value: null } if the key was absent
 *   - null if the proof failed verification
 */
export function verifyAvlLookup(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  key: Uint8Array,
): { value: Uint8Array | null } | null {
  const result = verifyAvlBatch(startingDigest, proof, config, [{ tag: 'Lookup', key }])
  if (result === null) return null
  return { value: result.results[0] ?? null }
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
