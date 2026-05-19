/**
 * verifyProof: public entry point composing parseProof + hasValidConnections +
 * monotonic-heights + per-header Autolykos PoW (v2 only; v1 skipped as Unsupported per sigma-rust).
 *
 * facts/nipopow.md postconditions:
 *   - headers.length === totalHeaders
 *   - headers heights are strictly increasing
 *   - headers[last].height === suffixTipHeight
 *   - continuous === false
 *   - If checkPoW === true, every version >= 2 header has a valid Autolykos v2 solution;
 *     version 1 headers are structurally accepted (Autolykos v1 PoW is not verified,
 *     mirroring sigma-rust's Unsupported behavior)
 *   - has_valid_connections holds across the proof
 *
 * Failure modes (all throw ProofVerificationError):
 *   'parse-failed'           bytes do not parse (wraps ProofParseError)
 *   'invalid-connections'    hasValidConnections returns false
 *   'non-increasing-heights' any consecutive pair violates strict monotonicity
 *   'empty-proof'            defensive dead-code guard — NipopowProof always has
 *                            at least suffixHead, so this branch is unreachable for
 *                            any proof that passes parseProof successfully
 *   'pow-failed'             Autolykos v2 rejects a version >= 2 header (when checkPoW: true)
 */

import { parseProof } from './proof.ts';
import type { NipopowProof } from './proof.ts';
import { hasValidConnections } from './connections.ts';
import { verifyAutolykosV2 } from './autolykos-v2.ts';
import type { Header } from './header.ts';
import type { PoPowHeader } from './popow-header.ts';
import {
  hashExtensionLeaf,
  merkleRootFromLeaves,
  packInterlinks,
  verifyBatchMerkleProof,
} from './merkle.ts';
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

  // ── Step 1.5: Interlinks Merkle proof per PoPowHeader ──────────────────────
  // Mirrors sigma-rust NipopowProof::is_valid → has_valid_proofs path
  // (ergo-nipopow/src/nipopow_proof.rs:187-191). KNOWN LIMITATION: the check
  // validates against a root computed from interlinks-only, NOT from
  // header.extensionRoot. Enforces internal proof consistency but not
  // anchoring to the on-chain extension commitment. See facts/nipopow.md.
  for (const ph of [proof.suffixHead, ...proof.prefix]) {
    if (!checkInterlinksProof(ph)) {
      throw new ProofVerificationError(
        `interlinks proof failed at height ${ph.header.height}`,
        'invalid-interlinks-proof',
      );
    }
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

    // Autolykos PoW check (skipped when checkPoW: false).
    // v1 headers use Autolykos v1 (different algorithm, not implemented here);
    // mirroring sigma-rust's check_pow which returns Err(Unsupported) for v1,
    // we skip PoW verification for version-1 headers.
    if (checkPoW && h.version !== 1 && !verifyAutolykosV2(h)) {
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

/**
 * Verify a PoPowHeader's interlinks Merkle proof.
 *
 * The NiPoPoW proof carries a BatchMerkleProof committing to the interlinks
 * vector. The proof is anchored to an interlinks-only ExtensionCandidate's
 * Merkle root (NOT to header.extensionRoot in general — the on-chain extension
 * may contain other fields, but the NiPoPoW protocol synthesizes an
 * interlinks-only extension for proof generation, matching what the verifier
 * reconstructs here). For blocks whose actual mainnet extension contains only
 * interlinks (no votes/params), header.extensionRoot happens to equal the
 * interlinks-only-root; for blocks with richer extensions the two diverge,
 * and verification anchors to interlinks-only-root not header.extensionRoot.
 *
 * Mirrors sigma-rust `PoPowHeader::check_interlinks_proof`
 * (ergo-nipopow/src/nipopow_proof.rs:302-323):
 *   1. Short-circuit: if interlinks empty AND proof empty → vacuously true.
 *   2. Pack interlinks to ExtensionKV pairs (JVM-compat key encoding —
 *      key=[0x01, first_position_in_interlinks_array]; see merkle.ts
 *      packInterlinks for details on the sigma-rust divergence).
 *   3. Compute the Merkle root from the packed leaves (interlinks-only).
 *   4. Verify the BatchMerkleProof's walk-up reaches the same root AND that
 *      the proof's stored leaf hashes match the packed-interlinks leaf hashes
 *      (the walk-up uses the stored hashes, so if they don't match what we
 *      computed from interlinks, either the interlinks or the proof was
 *      mutated and the walk-up won't reach the computed root).
 */
export function checkInterlinksProof(p: PoPowHeader): boolean {
  if (
    p.interlinks.length === 0 &&
    p.interlinksProof.indices.length === 0 &&
    p.interlinksProof.proofs.length === 0
  ) {
    return true;
  }
  const leaves = packInterlinks(p.interlinks);
  const leafHashes = leaves.map(hashExtensionLeaf);
  const expectedRoot = merkleRootFromLeaves(leafHashes);
  return verifyBatchMerkleProof(p.interlinksProof, leaves, expectedRoot);
}
