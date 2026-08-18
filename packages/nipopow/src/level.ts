/**
 * level.ts — shared superblock-level primitives.
 *
 * Extracted from compare.ts so the prover (provePrefix / updateInterlinks)
 * and the comparator (bestArg) consume the exact same maxLevelOf — see
 * facts/nipopow.md "Building blocks" for the public contract.
 *
 * Reference: sigma-rust ergo-nipopow/src/nipopow_algos.rs:best_arg, max_level_of
 *            sigma-rust ergo-chain-types/src/autolykos_pow_scheme.rs:pow_hit, max_level_of
 */

import type { Header } from '@ergots/scorex';
import {
  decodeCompactBits,
  autolykosMessage,
  calcBigN,
  autolykosHitForMessage,
  int32BE,
} from '@ergots/scorex';

// secp256k1 curve order (constant — matches sigma-rust order_bigint())
export const ORDER = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ─────────────────────────────────────────────────────────────────────────────
// max_level_of
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the maximum μ-level of a header.
 *
 * Truncates the float level toward zero — this is the primary, current
 * behavior, matching JVM `NipopowAlgos.scala maxLevelOf` (`Double.toInt`)
 * and the level-0 filtering in `NipopowProof.scala`. sigma-rust's
 * `max_level_of` also truncates (Rust's `as i32` cast from f64 truncates
 * toward zero, not floor) — `Math.floor` was never correct per either
 * reference; it was this package's own earlier implementation, since fixed.
 *
 *   - genesis (height == 1): return MAX (we use Number.MAX_SAFE_INTEGER to represent i32::MAX)
 *   - otherwise:
 *     required_target = (ORDER / decode_compact_bits(header.nBits)).toF64()
 *     real_target     = pow_hit(header).toF64()
 *     level           = trunc(log2(required_target) - log2(real_target))
 *                     = trunc(log2(required_target / real_target))
 *
 * The level is computed using f64 log2 subtraction (matching sigma-rust's
 * f64 cast), then truncated toward zero (see the -0 → 0 normalization below
 * for the one spot JS's `Math.trunc` needs help to match JVM/Rust exactly).
 * Returns a signed number; may be negative if the hit exceeds the required
 * target.
 */
export function maxLevelOf(header: Header): number {
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
  // JVM `level.toInt` / Rust `as i32`: truncation toward zero. NOT floor —
  // an epsilon-negative float level must map to 0 like the JVM, or
  // provePrefix's level-0 filter drops a header the JVM keeps.
  //
  // Math.trunc preserves the operand's sign on a zero-magnitude result
  // (Math.trunc(-0.585) === -0), a JS float64 artifact neither JVM `int` nor
  // Rust `i32` can represent (no signed zero). Normalize -0 → +0 so the
  // return value never carries a distinction the reference platforms don't
  // have; every comparison-based consumer (bestArg's `>= level`,
  // updateInterlinks's `<= 0` / `> 0`) treats -0 and 0 identically already,
  // so this only removes an artifact, it does not change any branch taken.
  const truncated = Math.trunc(level);
  return truncated === 0 ? 0 : truncated;
}

// ─────────────────────────────────────────────────────────────────────────────
// pow_hit (Autolykos v2)
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
export function powHit(header: Header): bigint {
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
