/**
 * GE canonical-bytes ingress helper (F5 batch 4).
 *
 * JVM GroupElementSerializer.parse (core/.../GroupElementSerializer.scala:35-42):
 *   lead byte != 0 → CryptoContext.decodePoint — curve-validates, throws on bad
 *                    prefix / x-not-on-curve;
 *   lead byte == 0 → identity point; bytes 1..32 NEVER inspected.
 * The JVM value is the decoded POINT and every egress re-serializes canonically
 * (identity = 33 zeros, :20-33). ergots mirrors by normalizing at ingress so GE
 * byte carriers are always canonical SEC1. Contract: facts/ergoscript-eval.md
 * "GE canonical-bytes invariant"; round-trip Carve-out 3 in facts/ergoscript-wire.md.
 *
 * For a VALID 02/03-lead payload the input bytes ARE the canonical encoding
 * (fixed-width big-endian x + parity prefix), so verbatim return is canonical —
 * pinned by the decodePoint→encodePoint identity test.
 */
import { decodePoint } from '../crypto/secp256k1'

/**
 * Validate + normalize a 33-byte GE wire payload.
 * Input MUST be exactly 33 bytes (asserted — non-33 throws `mkError`; call
 * sites feed struct fields as well as fixed-width reader reads, so misuse is
 * loud rather than silently treated as identity-or-point). Then: 0x00-lead →
 * fresh canonical 33-zero identity; valid 02/03 point → input verbatim;
 * anything else → throws `mkError(cause)`.
 */
export function canonicalGePayload(
  bytes33: Uint8Array,
  mkError: (cause: string) => Error,
): Uint8Array {
  if (bytes33.length !== 33) {
    throw mkError(`expected exactly 33 bytes, got ${bytes33.length}`)
  }
  if (bytes33[0] === 0x00) return new Uint8Array(33)
  try {
    decodePoint(bytes33) // validation only — valid input is already canonical
  } catch (cause) {
    throw mkError((cause as Error).message)
  }
  return bytes33
}
