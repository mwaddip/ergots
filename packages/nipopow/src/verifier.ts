/**
 * verifyProof: public entry point composing parseProof + hasValidConnections +
 * monotonic-heights + per-header Autolykos PoW (v2 only; v1 below activation
 * accepted structurally per sigma-rust's "Unsupported" semantics; v1 at or
 * above activation rejected per audit NIP-02).
 *
 * facts/nipopow.md postconditions:
 *   - headers.length === totalHeaders
 *   - headers heights are strictly increasing
 *   - headers[last].height === suffixTipHeight
 *   - continuous === false
 *   - If checkPoW === true, every version >= 2 header has a valid Autolykos v2
 *     solution under its self-declared nBits target; version 1 headers below
 *     opts.v2ActivationHeight (default V2_ACTIVATION_HEIGHT_MAINNET = 417792)
 *     are accepted structurally without PoW verification; version 1 headers
 *     at or above that height are rejected with 'v1-header-after-v2-activation'.
 *   - has_valid_connections holds across the proof
 *
 * Failure modes (all throw ProofVerificationError):
 *   'parse-failed'                    bytes do not parse (wraps ProofParseError)
 *   'invalid-connections'             hasValidConnections returns false
 *   'non-increasing-heights'          any consecutive pair violates strict monotonicity
 *   'empty-proof'                     defensive dead-code guard — NipopowProof always has
 *                                     at least suffixHead, so this branch is unreachable for
 *                                     any proof that passes parseProof successfully
 *   'pow-failed'                      Autolykos v2 rejects a version >= 2 header (when checkPoW: true)
 *   'v1-header-after-v2-activation'   version 1 header at height >= opts.v2ActivationHeight
 *                                     (when checkPoW: true); audit finding NIP-02
 *   'invalid-interlinks-proof'        per-PoPowHeader interlinks Merkle proof rejected
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

/**
 * Mainnet Autolykos v2 activation height. Below this height, V1 headers are
 * accepted structurally without PoW verification (Autolykos v1 is not
 * implemented in this package). At or above this height, V1 headers are
 * rejected. Source: ergo-node-rust chain config (`version2_activation_height`).
 *
 * Callers verifying proofs from a non-mainnet network should override via
 * `VerifyOptions.v2ActivationHeight`.
 */
export const V2_ACTIVATION_HEIGHT_MAINNET = 417792;

export interface VerifyOptions {
  checkPoW?: boolean;
  /**
   * Height at or above which a `version === 1` header is rejected as a forgery
   * (the Autolykos v1 PoW algorithm is not implemented in this package, so
   * accepting V1 at high heights would let an attacker bypass cryptographic
   * difficulty by marking forged headers as V1 — see audit NIP-02).
   *
   * Default: {@link V2_ACTIVATION_HEIGHT_MAINNET} (417792).
   *
   * Only consulted when `checkPoW` is `true`. When `checkPoW` is `false`,
   * V1 acceptance is unconditional (caller is responsible for PoW externally).
   */
  v2ActivationHeight?: number;
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
  // Audit NIP-09: enforce the same scalar shape invariants that parseProof
  // does (NIP-03 m > 0, NIP-04 k > 0) for hand-built proofs that bypass the
  // wire parser. Throws ProofVerificationError so the existing verify-error
  // class surface stays self-consistent (parse-tier errors stay
  // ProofParseError; verify-tier shape errors stay ProofVerificationError).
  //
  // Note: parseProof also rejects empty per-PoPowHeader interlinks at the
  // wire layer (NIP-05), but verifyParsedProof relies on the existing
  // checkInterlinksProof path for that — adding a parallel check here
  // would break the existing sigma-rust-compat "empty+empty vacuously true"
  // semantics for hand-built proofs.
  if (proof.m <= 0) {
    throw new ProofVerificationError(`m must be > 0; got ${proof.m}`, 'invalid-m');
  }
  if (proof.k <= 0) {
    throw new ProofVerificationError(`k must be > 0; got ${proof.k}`, 'invalid-k');
  }

  const checkPoW = opts.checkPoW ?? true;
  const v2ActivationHeight = opts.v2ActivationHeight ?? V2_ACTIVATION_HEIGHT_MAINNET;

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
    // Version 1 headers use Autolykos v1, which is NOT implemented in this
    // package. Pre-NIP-02 the verifier silently skipped V1 PoW at any height,
    // allowing an attacker to forge V1 headers at arbitrary heights and bypass
    // all difficulty checks. Post-NIP-02 we gate V1 acceptance on a configurable
    // V2-activation-height threshold: below the threshold V1 is accepted
    // structurally (matching sigma-rust's "Unsupported" semantics for legacy
    // prefix headers); at or above the threshold V1 is rejected as a forgery.
    if (checkPoW) {
      if (h.version === 1) {
        if (h.height >= v2ActivationHeight) {
          throw new ProofVerificationError(
            `version 1 header at height ${h.height} >= v2 activation height ${v2ActivationHeight}`,
            'v1-header-after-v2-activation',
          );
        }
        // V1 below activation: structurally accepted, PoW not verified.
      } else if (!verifyAutolykosV2(h)) {
        throw new ProofVerificationError(`PoW failed at height ${h.height}`, 'pow-failed');
      }
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
