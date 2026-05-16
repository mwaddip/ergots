/**
 * 24-byte sigma-protocol challenge operations.
 *
 * Challenges in Ergo's sigma protocols are 24 bytes (`SOUNDNESS_BITS = 192`).
 * The constant is hard-coded at the protocol level — Cthreshold polynomials
 * require GF(2^192). See sigma-rust `sigma_protocol.rs:104-107`.
 *
 * Scalar conversion (24-byte challenge → 32-byte scalar via left-pad) is
 * provided by `crypto/secp256k1.ts::scalarFromChallenge`; this module is
 * for byte-level operations on the 24-byte form.
 */

export const CHALLENGE_BYTES = 24

/**
 * Bytewise XOR of two challenges. Used to derive the last child's challenge
 * in a Cor (sig_serializer.rs:199-205) — defer to 2g-combinators verifier.
 *
 * Source: sigma-rust `challenge.rs:36-43`.
 */
export function challengeXor(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== CHALLENGE_BYTES || b.length !== CHALLENGE_BYTES) {
    throw new Error(`challengeXor: expected ${CHALLENGE_BYTES} bytes, got ${a.length}/${b.length}`)
  }
  const result = new Uint8Array(CHALLENGE_BYTES)
  for (let i = 0; i < CHALLENGE_BYTES; i++) result[i] = a[i]! ^ b[i]!
  return result
}
