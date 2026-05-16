/**
 * `verifySignature` — leaf-only sigma-protocol verifier (phase 2g-medium).
 *
 * Algorithm (mirrors sigma-rust `verifier.rs:91-125`):
 *
 *   1. TrivialProp short-circuit (returns sb.value, ignores signature)
 *   2. Reject empty signature (`empty-signature`) — sigma-rust returns
 *      Ok(false) on empty proof bytes at `verifier.rs:99`; TS surfaces as
 *      typed throw per Task 5 Decision #5.
 *   3. Reject conjecture variants (Cand/Cor/Cthreshold) → `conjecture-not-implemented`
 *   4. Parse top-level 24-byte challenge from signature
 *   5. Per-leaf read 32-byte z scalar (sig_serializer.rs:148-172)
 *   6. Compute Schnorr (ProveDlog) or DH-tuple (ProveDhTuple) commitment(s)
 *   7. Build Fiat-Shamir input: leaf_bytes(prop, commitment) ++ message
 *      (`fiat_shamir.rs:139-203` + `verifier.rs:117-118`)
 *   8. fiatShamirHash → 24-byte recomputed challenge
 *   9. Return bytewise equal(recomputed, top_level_challenge)
 *
 * The verifier is permissive about trailing bytes in the signature: sigma-rust
 * accepts `proof || extra_bytes` as long as the prefix parses cleanly
 * (`verifier.rs:229-235` proptest). We mirror that — `assertConsumed` is NOT
 * called.
 *
 * Sources:
 *   ergotree-interpreter/src/sigma_protocol/verifier.rs:91-125
 *   ergotree-interpreter/src/sigma_protocol/dlog_protocol.rs:173-184 (Schnorr)
 *   ergotree-interpreter/src/sigma_protocol/dht_protocol.rs:132-157 (DH-tuple)
 *   ergotree-interpreter/src/sigma_protocol/fiat_shamir.rs:139-203
 *   ergotree-interpreter/src/sigma_protocol/wscalar.rs:69-76 (left-pad)
 */

import type { SigmaBoolean } from '../mir/types'
import { VerifyError } from './errors'
import { readProofBytes } from './sig-serializer'
import { CHALLENGE_BYTES } from './challenge'
import { propBytes, fiatShamirHash, FIAT_SHAMIR_HASH_BYTES } from './fiat-shamir'
import {
  decodePoint,
  encodePoint,
  pointAdd,
  pointMul,
  pointNegate,
  basePoint,
  scalarFromBytes,
  scalarFromChallenge,
  type Point,
} from '../crypto/secp256k1'

const LEAF_PREFIX = 1

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Narrowed SigmaBoolean after `assertNoConjecture` — the conjecture variants
 * (Cand/Cor/Cthreshold) have been ruled out and remaining leaves are TrivialProp,
 * ProveDlog, or ProveDhTuple. TrivialProp is also handled upstream in
 * `verifySignature`, but keeping it here lets the helper narrow once. */
type LeafSigmaBoolean = Extract<SigmaBoolean, { tag: 'TrivialProp' | 'ProveDlog' | 'ProveDhTuple' }>

/**
 * Walk the SigmaBoolean and throw `conjecture-not-implemented` on
 * Cand/Cor/Cthreshold. Leaf-only verifier scope per the design spec; the
 * combinators land in 2g-combinators.
 *
 * TrivialProp / ProveDlog / ProveDhTuple are accepted leaves. Cand/Cor/
 * Cthreshold are conjecture nodes — encountering one anywhere in the tree
 * means the verifier can't handle this proposition yet.
 *
 * `asserts` return type narrows the input for downstream code so the
 * switch below doesn't need a `default: never` arm chasing impossible variants.
 */
function assertNoConjecture(sb: SigmaBoolean): asserts sb is LeafSigmaBoolean {
  switch (sb.tag) {
    case 'TrivialProp':
    case 'ProveDlog':
    case 'ProveDhTuple':
      return
    case 'Cand':
    case 'Cor':
    case 'Cthreshold':
      throw new VerifyError(
        `verifySignature: ${sb.tag} not implemented in phase 2g-medium (leaf-only verifier; deferred to 2g-combinators)`,
        'conjecture-not-implemented'
      )
    default: {
      const _exhaust: never = sb
      throw new Error(`assertNoConjecture: unreachable ${JSON.stringify(_exhaust)}`)
    }
  }
}

/**
 * Schnorr commitment recovery for a ProveDlog leaf.
 *
 *   a = G^z * (h^e)^-1
 *
 * In sigma-rust this is `g_z * &inverse(h_e)` where `Mul<&EcPoint>` is
 * point-addition (`ec_point.rs:74-79`). In TS additive form that's:
 *
 *   a = pointAdd(pointMul(G, z), pointNegate(pointMul(decode(h), e)))
 *
 * Source: ergotree-interpreter/src/sigma_protocol/dlog_protocol.rs:173-184
 */
function commitmentProveDlog(
  hBytes: Uint8Array,
  challenge: Uint8Array,
  zBytes: Uint8Array
): Uint8Array {
  const z = scalarFromBytes(zBytes)
  const e = scalarFromChallenge(challenge)
  const gz = pointMul(basePoint, z)
  const hPoint: Point = decodePoint(hBytes)
  const he = pointMul(hPoint, e)
  const a = pointAdd(gz, pointNegate(he))
  return encodePoint(a)
}

/**
 * DH-tuple commitment recovery for a ProveDhTuple leaf.
 *
 *   a = g^z * (u^e)^-1
 *   b = h^z * (v^e)^-1
 *
 * Source: ergotree-interpreter/src/sigma_protocol/dht_protocol.rs:132-157
 */
function commitmentProveDhTuple(
  gBytes: Uint8Array,
  hBytes: Uint8Array,
  uBytes: Uint8Array,
  vBytes: Uint8Array,
  challenge: Uint8Array,
  zBytes: Uint8Array
): { a: Uint8Array; b: Uint8Array } {
  const z = scalarFromBytes(zBytes)
  const e = scalarFromChallenge(challenge)
  const gPoint = decodePoint(gBytes)
  const hPoint = decodePoint(hBytes)
  const uPoint = decodePoint(uBytes)
  const vPoint = decodePoint(vBytes)
  const a = pointAdd(pointMul(gPoint, z), pointNegate(pointMul(uPoint, e)))
  const b = pointAdd(pointMul(hPoint, z), pointNegate(pointMul(vPoint, e)))
  return { a: encodePoint(a), b: encodePoint(b) }
}

/**
 * Build the Fiat-Shamir input for a single leaf and append the message.
 *
 * Format (`fiat_shamir.rs:139-203`):
 *   LEAF_PREFIX (1)
 *   | put_i16_be(prop.length)    (2-byte big-endian, NOT VLQ)
 *   | prop
 *   | put_i16_be(commitment.length)
 *   | commitment
 *
 * The verifier then appends `message` to this byte string (`verifier.rs:117-118`).
 */
function buildFiatShamirLeaf(
  prefix: number,
  prop: Uint8Array,
  commitment: Uint8Array,
  message: Uint8Array
): Uint8Array {
  // sigma-rust writes lengths as `put_i16_be_bytes(len as i16)`. The cast
  // wraps for len >= 0x8000; we reject early so our error surface stays
  // typed instead of silently producing a wrong Fiat-Shamir hash.
  // In practice propBytes for the leaf-only verifier is well below 1 KiB.
  if (prop.length > 0x7fff) {
    throw new VerifyError(
      `verifySignature: prop length ${prop.length} exceeds i16 range`,
      'truncated-signature'
    )
  }
  if (commitment.length > 0x7fff) {
    throw new VerifyError(
      `verifySignature: commitment length ${commitment.length} exceeds i16 range`,
      'truncated-signature'
    )
  }
  const total = 1 + 2 + prop.length + 2 + commitment.length + message.length
  const out = new Uint8Array(total)
  let off = 0
  out[off++] = prefix & 0xff
  out[off++] = (prop.length >> 8) & 0xff
  out[off++] = prop.length & 0xff
  out.set(prop, off)
  off += prop.length
  out[off++] = (commitment.length >> 8) & 0xff
  out[off++] = commitment.length & 0xff
  out.set(commitment, off)
  off += commitment.length
  out.set(message, off)
  return out
}

/**
 * Verify a sigma-protocol signature for a leaf-only SigmaBoolean proposition.
 *
 * @param sb        Proposition to verify against (must NOT contain
 *                  Cand/Cor/Cthreshold nodes in phase 2g-medium).
 * @param message   Message that was signed.
 * @param signature Proof bytes (24-byte challenge || 32-byte z for ProveDlog
 *                  or ProveDhTuple).
 * @returns         `true` iff the signature verifies.
 * @throws VerifyError on conjecture inputs, empty / truncated signatures, or
 *                     out-of-range scalar / invalid point encodings.
 */
export function verifySignature(
  sb: SigmaBoolean,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  // Step 1: TrivialProp short-circuit — ignores signature entirely.
  if (sb.tag === 'TrivialProp') return sb.value

  // Step 2: empty signature → 'empty-signature' typed throw.
  const reader = readProofBytes(signature)

  // Step 3: reject conjecture variants.
  assertNoConjecture(sb)

  // Step 4: parse top-level 24-byte challenge.
  const challenge = reader.readChallenge()
  if (challenge.length !== CHALLENGE_BYTES) {
    // Defensive: readChallenge always returns CHALLENGE_BYTES on success;
    // this branch is unreachable but documents the invariant.
    throw new VerifyError(
      `verifySignature: bad challenge length ${challenge.length}`,
      'truncated-signature'
    )
  }

  // Step 5: per-leaf z scalar + commitment bytes.
  let commitmentBytes: Uint8Array
  switch (sb.tag) {
    case 'ProveDlog': {
      const zBytes = reader.readScalarBytes()
      commitmentBytes = commitmentProveDlog(sb.h, challenge, zBytes)
      break
    }
    case 'ProveDhTuple': {
      const zBytes = reader.readScalarBytes()
      const { a, b } = commitmentProveDhTuple(sb.g, sb.h, sb.u, sb.v, challenge, zBytes)
      // Concatenate a || b for the Fiat-Shamir commitment payload, mirroring
      // FirstDhTupleProverMessage::bytes (`dht_protocol.rs:33-38`).
      commitmentBytes = new Uint8Array(a.length + b.length)
      commitmentBytes.set(a, 0)
      commitmentBytes.set(b, a.length)
      break
    }
    // TrivialProp + conjectures already handled above.
    default: {
      const _exhaust: never = sb
      throw new Error(`verifySignature: unreachable ${JSON.stringify(_exhaust)}`)
    }
  }

  // Step 6: Fiat-Shamir input.
  const prop = propBytes(sb)
  const fiatInput = buildFiatShamirLeaf(LEAF_PREFIX, prop, commitmentBytes, message)

  // Step 7: hash → 24-byte recomputed challenge.
  const recomputed = fiatShamirHash(fiatInput)
  if (recomputed.length !== FIAT_SHAMIR_HASH_BYTES) {
    // Defensive: fiatShamirHash always returns FIAT_SHAMIR_HASH_BYTES.
    throw new Error(
      `verifySignature: fiatShamirHash returned ${recomputed.length} bytes, expected ${FIAT_SHAMIR_HASH_BYTES}`
    )
  }

  // Step 8: compare.
  return bytesEqual(recomputed, challenge)
}
