/**
 * secp256k1 adapter — phase 2g-medium.
 *
 * Thin wrapper over `@noble/curves@2.2.0`'s secp256k1 module. Exposes only
 * the operations the leaf-only sigma-protocol verifier uses (Task 6).
 * Localizes the curves dependency surface so future @noble/curves upgrades
 * touch one file.
 *
 * **Ergo identity convention:** 33 zero bytes ↔ point-at-infinity. This is
 * NOT native SEC1 — sigma-rust's `ec_point.rs:130-152` introduces this
 * convention to make sigma-proof bytes round-trip cleanly. The adapter
 * handles the conversion; no caller needs to know.
 *
 * **API notes for @noble/curves@2.2.0** (verified against installed package):
 * - `secp256k1.CURVE` is not a direct property — group order n lives at
 *   `secp256k1.Point.Fn.ORDER` (scalar field ORDER === curve order n).
 * - `Point.ZERO.toBytes()` throws "bad point: ZERO" — use `.is0()` to detect
 *   the identity before attempting encoding.
 * - `Point.multiply(0n)` throws "invalid scalar: out of range" — guard with
 *   explicit zero check before calling `multiply`.
 *
 * Source: ~/projects/sigma-rust/sigma-rust/ergo-chain-types/src/ec_point.rs
 *         ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/wscalar.rs
 */

import { secp256k1 } from '@noble/curves/secp256k1.js'

const POINT_BYTES = 33  // SEC1 compressed

/**
 * Opaque curve point type — inferred from the Point constructor so callers
 * don't import directly from `@noble/curves/abstract/weierstrass.js`.
 */
export type Point = ReturnType<typeof secp256k1.Point.BASE.multiply>

/**
 * The secp256k1 generator point (base point G).
 * Source: sigma-rust `dlog_group.rs:46-48`.
 */
export const basePoint: Point = secp256k1.Point.BASE

/**
 * The secp256k1 group order n.
 * Source: sigma-rust `dlog_group.rs:46-48`.
 *
 * API note: `@noble/curves@2.2.0` does not expose `secp256k1.CURVE.n` directly.
 * The scalar field `Point.Fn.ORDER` equals the group order n.
 */
export const groupOrder: bigint = secp256k1.Point.Fn.ORDER

function isZero33(bytes: Uint8Array): boolean {
  if (bytes.length !== POINT_BYTES) return false
  for (let i = 0; i < POINT_BYTES; i++) if (bytes[i] !== 0) return false
  return true
}

/**
 * Decode a 33-byte SEC1 compressed point. The Ergo convention: 33 zero bytes
 * decodes to the identity (point-at-infinity).
 *
 * **Deliberate divergence from sigma-rust (documented strict-reject):**
 * sigma-rust's `ec_point.rs:139-151` dispatches on `buf[0] != 0` alone —
 * ANY 33-byte payload whose first byte is `0x00` is silently treated as
 * identity, regardless of the remaining 32 bytes. Our adapter requires
 * ALL 33 bytes to be zero (`isZero33`) and rejects malformed
 * `[0x00, non-zero...]` inputs as invalid SEC1.
 *
 * **Why strict-reject is correct:** the divergence is unreachable on
 * well-formed inputs because sigma-rust's serializer at
 * `ec_point.rs:127-136` always emits identity as exactly 33 zero bytes
 * (`is_identity → write [0u8; 33]`). The only inputs that trigger the
 * divergence are hand-crafted MIR or hostile peer bytes. For hostile
 * inputs, strict-reject is a small additional safety margin: we don't
 * silently accept malformed-but-byte-zero-prefixed encodings.
 *
 * Consumers (9 invocations across 4 files: verifier.ts ×5, decode-point.ts,
 * multiply-group.ts ×2, exponentiate.ts) carry a per-file pointer comment
 * back to this docstring rather than copy-pasting the rationale.
 *
 * Throws on wrong length or invalid SEC1 encoding.
 *
 * Source: sigma-rust `ec_point.rs:127-151` (Ergo identity convention +
 *         divergence reference).
 */
export function decodePoint(bytes: Uint8Array): Point {
  if (bytes.length !== POINT_BYTES) {
    throw new Error(`decodePoint: expected ${POINT_BYTES} bytes, got ${bytes.length}`)
  }
  if (isZero33(bytes)) {
    // Ergo identity convention — return the curve identity (point-at-infinity).
    return secp256k1.Point.ZERO
  }
  return secp256k1.Point.fromBytes(bytes)
}

/**
 * Encode a Point to 33-byte SEC1 compressed. Identity → 33 zero bytes (Ergo
 * convention).
 *
 * API note: `Point.ZERO.toBytes()` throws in @noble/curves@2.2.0; use
 * `.is0()` to detect identity before calling `toBytes`.
 *
 * Source: sigma-rust `ec_point.rs:130-152` (Ergo identity convention).
 */
export function encodePoint(p: Point): Uint8Array {
  if (p.is0()) return new Uint8Array(POINT_BYTES)
  const bytes = p.toBytes(true)  // compressed
  if (bytes.length !== POINT_BYTES) {
    throw new Error(`encodePoint: produced ${bytes.length} bytes, expected ${POINT_BYTES}`)
  }
  return bytes
}

/** Point addition. */
export function pointAdd(a: Point, b: Point): Point {
  return a.add(b)
}

/** Point negation. */
export function pointNegate(p: Point): Point {
  return p.negate()
}

/**
 * Scalar multiplication. Handles k === 0n and k ≡ 0 (mod n) explicitly
 * because `@noble/curves@2.2.0` throws "invalid scalar: out of range" for
 * zero scalars.
 */
export function pointMul(p: Point, k: bigint): Point {
  if (k === 0n) return secp256k1.Point.ZERO
  // Reduce k into [1, n-1] before calling multiply.
  const kReduced = ((k % groupOrder) + groupOrder) % groupOrder
  if (kReduced === 0n) return secp256k1.Point.ZERO
  return p.multiply(kReduced)
}

/**
 * Decode a 32-byte big-endian scalar, reducing mod n.
 * Mirrors sigma-rust's `Scalar::reduce_bytes` (`wscalar.rs:60-67`).
 */
export function scalarFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error(`scalarFromBytes: expected 32 bytes, got ${bytes.length}`)
  }
  let n = 0n
  for (let i = 0; i < 32; i++) {
    n = (n << 8n) | BigInt(bytes[i]!)
  }
  return n % groupOrder
}

/**
 * Decode a 24-byte challenge by left-padding with 8 zero bytes (treating it
 * as the low-order 24 bytes of a 32-byte big-endian scalar), then reducing
 * mod n.
 *
 * Source: sigma-rust `wscalar.rs:69-76`.
 *
 * Critical: the left-pad direction matters. Right-pad gives the wrong scalar
 * and silently breaks every verification.
 */
export function scalarFromChallenge(challenge: Uint8Array): bigint {
  if (challenge.length !== 24) {
    throw new Error(`scalarFromChallenge: expected 24 bytes, got ${challenge.length}`)
  }
  const padded = new Uint8Array(32)
  padded.set(challenge, 8)  // left-pad: 8 zero bytes then the 24-byte challenge
  return scalarFromBytes(padded)
}
