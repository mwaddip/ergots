/**
 * verifyProof: public entry point composing parseProof + hasValidConnections +
 * monotonic-heights + per-header Autolykos v2.
 *
 * facts/proof.md postconditions:
 *   - headers.length === totalHeaders
 *   - headers heights are strictly increasing
 *   - headers[last].height === suffixTipHeight
 *   - continuous === false
 *   - If checkPoW === true, every header has a valid Autolykos v2 solution
 *   - has_valid_connections holds across the proof
 *
 * Failure modes (all throw ProofVerificationError):
 *   'parse-failed'           bytes do not parse (wraps ProofParseError)
 *   'invalid-connections'    hasValidConnections returns false
 *   'non-increasing-heights' any consecutive pair violates strict monotonicity
 *   'empty-proof'            defensive dead-code guard — NipopowProof always has
 *                            at least suffixHead, so this branch is unreachable for
 *                            any proof that passes parseProof successfully
 *   'pow-failed'             Autolykos v2 rejects a header (when checkPoW: true)
 */

import { parseProof } from './proof.ts';
import type { NipopowProof } from './proof.ts';
import { hasValidConnections } from './connections.ts';
import { verifyAutolykosV2 } from './autolykos-v2.ts';
import type { Header } from './header.ts';
import { ProofVerificationError, ProofParseError } from './errors.ts';

export interface VerifyOptions {
  checkPoW?: boolean;
}

export interface VerificationResult {
  suffixTipHeight: number;
  totalHeaders: number;
  continuous: false;
  headers: Header[];
}

/**
 * Verify an already-parsed NiPoPoW proof in-memory.
 *
 * Composes: hasValidConnections → monotonic-height walk → optional PoW.
 * This is the inner logic that `verifyProof` delegates to after parsing.
 * Exported for unit-testing logical invariants (heights, connections) without
 * requiring round-trip serialization.
 *
 * @param proof  A parsed NipopowProof.
 * @param opts   `{ checkPoW?: boolean }` — defaults to `{ checkPoW: true }`.
 * @returns      VerificationResult on success.
 * @throws       ProofVerificationError on any validation failure.
 */
export function verifyParsedProof(proof: NipopowProof, opts: VerifyOptions = {}): VerificationResult {
  const checkPoW = opts.checkPoW ?? true;

  // ── Step 1: Connections ────────────────────────────────────────────────────
  if (!hasValidConnections(proof)) {
    throw new ProofVerificationError('invalid connections', 'invalid-connections');
  }

  // ── Step 2: Build header list ──────────────────────────────────────────────
  // [prefix[0].header, ..., prefix[last].header, suffixHead.header, ...suffixTail]
  const allHeaders: Header[] = [
    ...proof.prefix.map(p => p.header),
    proof.suffixHead.header,
    ...proof.suffixTail,
  ];

  if (allHeaders.length === 0) {
    // Defensive dead-code guard: NipopowProof always has suffixHead, so this
    // branch is unreachable for any proof successfully returned by parseProof.
    throw new ProofVerificationError('empty proof headers chain', 'empty-proof');
  }

  // ── Step 3: Monotonic-height + optional PoW ────────────────────────────────
  let lastHeight: number | null = null;
  for (const h of allHeaders) {
    // Strictly increasing heights
    if (lastHeight !== null && h.height <= lastHeight) {
      throw new ProofVerificationError(
        `non-increasing heights: ${h.height} after ${lastHeight}`,
        'non-increasing-heights',
      );
    }
    lastHeight = h.height;

    // Autolykos v2 PoW (skipped when checkPoW: false)
    if (checkPoW && !verifyAutolykosV2(h)) {
      throw new ProofVerificationError(`PoW failed at height ${h.height}`, 'pow-failed');
    }
  }

  return {
    suffixTipHeight: lastHeight!,
    totalHeaders: allHeaders.length,
    continuous: false,
    headers: allHeaders,
  };
}

/**
 * Verify a NiPoPoW proof from raw bytes.
 *
 * Composes: parse → verifyParsedProof (connections + heights + optional PoW).
 *
 * @param bytes  Raw wire bytes of the proof (must be ≥ 1 and ≤ 2_000_000 bytes).
 * @param opts   `{ checkPoW?: boolean }` — defaults to `{ checkPoW: true }`.
 * @returns      VerificationResult on success.
 * @throws       ProofVerificationError on any validation failure.
 */
export function verifyProof(bytes: Uint8Array, opts: VerifyOptions = {}): VerificationResult {
  // ── Step 1: Parse ──────────────────────────────────────────────────────────
  let proof: NipopowProof;
  try {
    proof = parseProof(bytes);
  } catch (e) {
    if (e instanceof ProofParseError) {
      throw new ProofVerificationError(
        `parse failed: ${e.message}`,
        'parse-failed',
        { cause: e },
      );
    }
    throw e; // unexpected error — bubble up as-is
  }

  return verifyParsedProof(proof, opts);
}
