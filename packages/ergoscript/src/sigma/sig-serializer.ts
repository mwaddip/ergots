/**
 * Sigma-proof byte reader — phase 2g-medium leaf-only.
 *
 * Provides primitives for reading proof bytes structurally guided by a
 * SigmaBoolean tree. The verifier (Task 6) composes these into the full
 * tree walk.
 *
 * Per-leaf format (sigma-rust `sig_serializer.rs:148-172`):
 *   ProveDlog:     [24-byte challenge if required] + [32-byte z scalar]
 *   ProveDhTuple:  [24-byte challenge if required] + [32-byte z scalar]
 *
 * Top-level always has the 24-byte challenge (`sig_serializer.rs:143`).
 *
 * Conjecture handling (Cand inherits parent; Cor XORs; Cthreshold
 * polynomial) is NOT in 2g-medium — deferred to 2g-combinators.
 */

import { CHALLENGE_BYTES } from './challenge'
import { VerifyError } from './errors'

export const SCALAR_BYTES = 32

export class ProofBytesReader {
  private pos: number = 0

  constructor(private readonly bytes: Uint8Array) {}

  remaining(): number {
    return this.bytes.length - this.pos
  }

  readChallenge(): Uint8Array {
    return this.readN(CHALLENGE_BYTES)
  }

  readScalarBytes(): Uint8Array {
    return this.readN(SCALAR_BYTES)
  }

  private readN(n: number): Uint8Array {
    if (this.remaining() < n) {
      throw new VerifyError(
        `truncated-signature: needed ${n} bytes, have ${this.remaining()}`,
        'truncated-signature'
      )
    }
    const slice = this.bytes.slice(this.pos, this.pos + n)
    this.pos += n
    return slice
  }

  /** Assert all bytes consumed (defense against trailing garbage; optional). */
  assertConsumed(): void {
    if (this.remaining() > 0) {
      throw new VerifyError(
        `truncated-signature: ${this.remaining()} trailing bytes`,
        'truncated-signature'
      )
    }
  }
}

/**
 * Construct a ProofBytesReader, rejecting empty input.
 *
 * Sigma-rust returns `Ok(false)` on empty proofs (`sig_serializer.rs:118-128`);
 * TS surfaces as a typed throw for caller telemetry per design Decision #5.
 */
export function readProofBytes(signature: Uint8Array): ProofBytesReader {
  if (signature.length === 0) {
    throw new VerifyError('empty-signature: proof bytes are empty', 'empty-signature')
  }
  return new ProofBytesReader(signature)
}
