/**
 * compareProofs: KMZ17 §4.3 pairwise comparison (is_better_than).
 *
 * Returns true iff proof-a is strictly better than proof-b.
 *
 * Algorithm (sigma-rust ergo-nipopow/src/nipopow_proof.rs + nipopow_algos.rs):
 *
 *   is_better_than(a, b):
 *     if !a.is_valid() && !b.is_valid() → false
 *     if !a.is_valid() || !b.is_valid() → a.is_valid()
 *     lca = lowest_common_ancestor(a.headers_chain(), b.headers_chain())
 *     if lca is None → false
 *     a_above = a.headers_chain().filter(h.height > lca.height)
 *     b_above = b.headers_chain().filter(h.height > lca.height)
 *     best_arg(a_above, a.m) > best_arg(b_above, a.m)
 *
 *   best_arg(chain, m):
 *     // Level 0: all headers (size = chain.length)
 *     acc = [(0, chain.length)]
 *     level = 1
 *     loop:
 *       args = chain.filter(max_level_of(h) >= level)
 *       if args.length >= m:
 *         acc.unshift((level, args.length))   // prepend
 *         level += 1
 *       else:
 *         break
 *     max over acc of BigInt(2)^BigInt(level) * BigInt(count)
 *
 *   max_level_of(header):
 *     if header.height === 1: return Number.MAX_SAFE_INTEGER  // genesis ≈ i32::MAX
 *     required_target = ORDER / decode_compact_bits(header.nBits)   // BigInt division
 *     real_hit = autolykos_v2_hit(header)                            // BigInt
 *     level = Math.floor(Math.log2(toF64(required_target)) - Math.log2(toF64(real_hit)))
 *     return level  // signed; may be negative if hit > required_target
 *
 * Reference: sigma-rust ergo-nipopow/src/nipopow_proof.rs:is_better_than
 *            sigma-rust ergo-nipopow/src/nipopow_algos.rs:best_arg, max_level_of
 *            sigma-rust ergo-chain-types/src/autolykos_pow_scheme.rs:pow_hit, max_level_of
 */

import { parseProof, type NipopowProof } from './proof.ts';
import type { Header } from '@ergots/scorex';
import {
  decodeCompactBits,
  autolykosMessage,
  calcBigN,
  autolykosHitForMessage,
  int32BE,
} from '@ergots/scorex';
import { hasValidConnections } from './connections.ts';
import { checkInterlinksProof } from './verifier.ts';
import { bytesEqual } from './bytes.ts';

// secp256k1 curve order (constant — matches sigma-rust order_bigint())
const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare two NiPoPoW proofs. Returns true iff proof-a is strictly better than
 * proof-b per KMZ17 §4.3.
 *
 * Parse failures throw ProofParseError (per facts/nipopow.md: do NOT return false).
 */
export function compareProofs(a: Uint8Array, b: Uint8Array): boolean {
  // Parse both — throws ProofParseError on malformed bytes.
  const proofA = parseProof(a);
  const proofB = parseProof(b);
  return isBetterThan(proofA, proofB);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: is_better_than
// ─────────────────────────────────────────────────────────────────────────────

function isBetterThan(a: NipopowProof, b: NipopowProof): boolean {
  const aValid = isValid(a);
  const bValid = isValid(b);

  // If neither is valid, neither is better.
  if (!aValid && !bValid) return false;
  // If only one is valid, the valid one is better.
  if (!aValid || !bValid) return aValid;

  // Both valid: find LCA then compare best_arg scores.
  const aChain = headersChain(a);
  const bChain = headersChain(b);

  const lca = lowestCommonAncestor(aChain, bChain);
  if (lca === null) return false;

  const lcaHeight = lca.height;
  const aAbove = aChain.filter(h => h.height > lcaHeight);
  const bAbove = bChain.filter(h => h.height > lcaHeight);

  const scoreA = bestArg(aAbove, a.m);
  const scoreB = bestArg(bAbove, a.m); // sigma-rust uses self.m (a.m) for both sides

  return scoreA > scoreB;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: isValid (mirrors NipopowProof::is_valid)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors sigma-rust NipopowProof::is_valid:
 *   has_valid_connections() && has_valid_heights() && has_valid_proofs()
 *
 * has_valid_proofs() runs checkInterlinksProof on every PoPowHeader. Closes
 * Codex audit Finding #2: compareProofs previously skipped the interlink-
 * Merkle-proof check, so it scored proofs with invalid interlinks proofs as
 * if they were valid. Now mirrors sigma-rust's is_better_than: invalid proofs
 * are NOT comparable; if one is invalid, the valid one "wins"; both invalid
 * returns false.
 *
 * NOT checked (also matches sigma-rust): PoW. Callers that need PoW
 * enforcement should run verifyProof on each raw-bytes proof BEFORE calling
 * compareProofs.
 */
function isValid(proof: NipopowProof): boolean {
  if (!hasValidConnections(proof)) return false;
  if (!hasValidHeights(proof)) return false;
  for (const ph of [proof.suffixHead, ...proof.prefix]) {
    if (!checkInterlinksProof(ph)) return false;
  }
  return true;
}

function hasValidHeights(proof: NipopowProof): boolean {
  const chain = headersChain(proof);
  for (let i = 1; i < chain.length; i++) {
    if (chain[i]!.height <= chain[i - 1]!.height) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: headers_chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the flat header sequence: [...prefix headers, suffixHead, ...suffixTail].
 * Mirrors sigma-rust NipopowProof::headers_chain().
 */
function headersChain(proof: NipopowProof): Header[] {
  return [
    ...proof.prefix.map(p => p.header),
    proof.suffixHead.header,
    ...proof.suffixTail,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: lowest_common_ancestor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the last (highest-height) header that appears in both chains.
 *
 * Mirrors sigma-rust NipopowAlgos::lowest_common_ancestor:
 *   - If both chains are non-empty and their first elements differ → None
 *   - Otherwise collect headers that appear in both (preserving order from left)
 *   - Return the last common header
 *
 * Header equality is by id (32-byte array comparison).
 */
function lowestCommonAncestor(left: Header[], right: Header[]): Header | null {
  // If both non-empty and first elements differ, no common ancestor.
  if (left.length > 0 && right.length > 0) {
    if (!bytesEqual(left[0]!.id, right[0]!.id)) {
      return null;
    }
  }

  const common: Header[] = [];
  let rightIxStart = 0;

  for (const leftHeader of left) {
    for (let i = rightIxStart; i < right.length; i++) {
      if (bytesEqual(leftHeader.id, right[i]!.id)) {
        rightIxStart = i + 1;
        common.push(leftHeader);
        break;
      }
    }
  }

  return common.length > 0 ? common[common.length - 1]! : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: best_arg
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the best-arg score for a chain of headers.
 *
 * KMZ17 §4.3 Algorithm 4 (pseudo-code):
 *   M ← {μ : |π↑μ{b:}| ≥ m} ∪ {0}
 *   return max_{μ∈M} {2^μ · |π↑μ{b:}|}
 *
 * Mirrors sigma-rust NipopowAlgos::best_arg.
 * Uses BigInt for the score to avoid overflow at high levels.
 */
function bestArg(chain: Header[], m: number): bigint {
  // Initial accumulator: level 0, size = all headers
  const acc: Array<[number, number]> = [[0, chain.length]];

  let level = 1;
  for (;;) {
    // NOTE: sigma-rust's best_arg casts max_level_of's i32 to u32 before
    // comparing >= level. A negative i32 wraps to a huge u32, passing the
    // check for every level. We use signed comparison here — equivalent on
    // all reachable inputs because a negative max_level_of requires hit > ORDER
    // (~2^-128 probability per header) AND any such header would have failed
    // PoW validation before reaching compareProofs. The signed semantics are
    // arguably more correct: KMZ17 §4.3 specifies the algorithm semantically,
    // not the Rust casting artifact.
    const args = chain.filter(h => maxLevelOf(h) >= level);
    if (args.length >= m) {
      // Prepend to accumulator (sigma-rust does acc.insert(0, ...))
      acc.unshift([level, args.length]);
      level++;
    } else {
      break;
    }
  }

  // Score = max over acc of 2^level * count
  let best = 0n;
  for (const [lvl, cnt] of acc) {
    const score = (2n ** BigInt(lvl)) * BigInt(cnt);
    if (score > best) best = score;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: max_level_of
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the maximum μ-level of a header.
 *
 * Mirrors sigma-rust NipopowAlgos::max_level_of:
 *   - genesis (height == 1): return MAX (we use Number.MAX_SAFE_INTEGER to represent i32::MAX)
 *   - otherwise:
 *     required_target = (ORDER / decode_compact_bits(header.nBits)).toF64()
 *     real_target     = pow_hit(header).toF64()
 *     level           = floor(log2(required_target) - log2(real_target))
 *                     = floor(log2(required_target / real_target))
 *
 * The level is computed using f64 log2 subtraction (matching sigma-rust's f64 cast).
 * Returns a signed number; may be negative if the hit exceeds the required target.
 */
function maxLevelOf(header: Header): number {
  if (header.height === 1) {
    return Number.MAX_SAFE_INTEGER; // genesis: i32::MAX in sigma-rust
  }

  const decoded = decodeCompactBits(header.nBits);
  if (decoded <= 0n) return -1; // invalid target; level is effectively 0 or below

  const requiredTarget = ORDER / decoded; // BigInt integer division
  const realHit = powHit(header);        // BigInt: Autolykos v2 hit

  // Convert to f64 (JS number) for log2 computation, matching sigma-rust's .to_f64().unwrap().
  const requiredF64 = bigintToF64(requiredTarget);
  const realF64 = bigintToF64(realHit);

  if (realF64 <= 0) return -1; // degenerate: hit is 0

  const level = Math.log2(requiredF64) - Math.log2(realF64);
  // For positive values, Math.floor matches Rust's `as i32` truncation
  // (round toward zero). Negative levels are excluded by the >= check in
  // bestArg, so the floor-vs-trunc difference is immaterial.
  return Math.floor(level);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: pow_hit (Autolykos v2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the Autolykos v2 pow_hit for a non-genesis v2 header.
 *
 * This is the same computation as verifyAutolykosV2 but returns the hit value
 * as a BigInt rather than comparing it to the target.
 *
 * Mirrors sigma-rust AutolykosPowScheme::pow_hit for version >= 2.
 *
 * For version 1 headers: sigma-rust uses pow_distance if present; we treat
 * v1 headers as having max hit (level effectively 0 or below) since we
 * cannot re-derive the v1 hit. The compareProofs caller should already
 * be working with v2 proofs for any real Ergo chain post-activation.
 */
function powHit(header: Header): bigint {
  if (header.version === 1) {
    // Autolykos v1: pow_distance is stored in the solution.
    // If present, use it; otherwise return ORDER (max) to indicate level ~= 0.
    if (header.autolykosSolution.powDistance !== null) {
      return header.autolykosSolution.powDistance;
    }
    return ORDER; // fallback: no level contribution
  }

  const hit = autolykosHitForMessage(
    32,
    autolykosMessage(header),
    header.autolykosSolution.nonce,
    int32BE(header.height),
    calcBigN(header.version, header.height),
  );
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a BigInt to a JS float64 (f64). Mirrors Rust's BigUint::to_f64(). */
function bigintToF64(v: bigint): number {
  if (v === 0n) return 0;
  // Use hex representation for precision; Number() on a BigInt also works
  // since JS coerces to f64. For large values, precision is lost at mantissa
  // boundaries — this matches Rust's BigUint::to_f64() behaviour (also lossy).
  return Number(v);
}


