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

/**
 * Decode an EC point from bytes, byte-for-byte faithful to sigma-rust's
 * `EcPoint::scorex_parse` (`ergo-chain-types/src/ec_point.rs:139-151`):
 *
 * ```rust
 * let mut buf = [0; 33];
 * r.read_exact(&mut buf[..])?;     // needs ≥ 33 bytes; trailing ignored
 * if buf[0] != 0 { PublicKey::from_sec1_bytes(&buf) }   // strict SEC1
 * else { Ok(EcPoint(ProjectivePoint::IDENTITY)) }       // buf[0]==0 ⇒ identity
 * ```
 *
 * So a **leading `0x00` byte ⇒ the identity (point-at-infinity)**, and bytes
 * 1..32 are NEVER inspected — NOT only the all-zero encoding. And the decoder
 * reads exactly the first 33 bytes, **tolerating trailing bytes** (sigma-rust's
 * `sigma_parse_bytes` wraps a cursor with no full-consumption check).
 *
 * Iter-24 (mainnet h=1,111,884, tx1/input0): `decodePoint(SELF.R4.slice(3, …))`
 * fed 514 bytes whose 33-byte prefix leads with `0x00` (R4 is an embedded
 * ErgoTree). sigma-rust returns identity; the prior strict adapter here
 * (require exactly 33; identity only when ALL 33 bytes zero) threw and halted
 * the validator. The earlier docstring marked this `[0x00, non-zero] ⇒ identity`
 * case "production-unreachable" — h=1,111,884 falsified that, so we now mirror
 * sigma-rust exactly. (Confirmed against pinned sigma-rust 3aa0832 by the
 * ergo-node-rust session.)
 *
 * Throws only when fewer than 33 bytes are available (mirrors `read_exact`) or
 * when a non-`0x00`-lead payload fails SEC1 decode.
 */
export function decodePoint(bytes: Uint8Array): Point {
  if (bytes.length < POINT_BYTES) {
    throw new Error(`decodePoint: expected >= ${POINT_BYTES} bytes, got ${bytes.length}`)
  }
  // read_exact reads exactly 33 bytes; any trailing bytes are ignored.
  const head = bytes.length === POINT_BYTES ? bytes : bytes.subarray(0, POINT_BYTES)
  if (head[0] === 0x00) {
    // sigma-rust: buf[0] == 0 ⇒ identity, regardless of bytes 1..32.
    return secp256k1.Point.ZERO
  }
  return secp256k1.Point.fromBytes(head)
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
 * base^k on secp256k1 at the BYTE level: decode → identity-base guard →
 * `pointMul` (mod-n reduction; k=0 / k≡0 (mod n) → ZERO) → encode (ZERO →
 * 33 zero bytes, the Ergo identity convention).
 *
 * The identity-base guard is LOAD-BEARING: `@noble/curves` `Point.multiply`
 * does NOT short-circuit `Point.ZERO` (see `eval/exponentiate.ts` module docs
 * for the full rationale + sigma-rust `ec_point.rs:113-118` correspondence).
 *
 * Shared by the v5 `Exponentiate` arm (signed BigInt exponent) and
 * `SGroupElement.expUnsigned` 7:6 (UBI exponent ∈ [0, 2²⁵⁶), v6 P7a) — the
 * mod-n reduction in `pointMul` covers both ranges identically.
 */
export function expPoint(baseBytes: Uint8Array, k: bigint): Uint8Array {
  const base = decodePoint(baseBytes)
  if (base.is0()) return new Uint8Array(POINT_BYTES) // identity^k = identity
  return encodePoint(pointMul(base, k))
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
