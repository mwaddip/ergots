/**
 * Sigma-proof byte reader — phase 2g-medium leaf-only.
 *
 * Provides primitives for reading proof bytes structurally guided by a
 * SigmaBoolean tree. The verifier (Task 6) composes these into the full
 * tree walk.
 *
 * Per-leaf format (sigma-rust `sig_serializer.rs:148-172`):
 *   ProveDlog:     [24-byte challenge if required] + [up to 32-byte z scalar]
 *   ProveDhTuple:  [24-byte challenge if required] + [up to 32-byte z scalar]
 *
 * Top-level always has the 24-byte challenge (`sig_serializer.rs:143`).
 *
 * **Scalar leniency:** sigma-rust's `read_scalar` (sig_serializer.rs:250-255)
 * reads UP TO GROUP_SIZE (32) bytes and right-shifts them into a zero-filled
 * 32-byte buffer (left-pads with zeros). Prover-side optimisations strip
 * leading zero bytes from small-magnitude z scalars, so on-wire proofs are
 * variable-length (a 24+31=55-byte P2PK signature surfaces at mainnet
 * h=220541). `readScalarBytes` mirrors this — it never throws on underrun.
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

  /**
   * Read a z scalar — UP TO `SCALAR_BYTES` (32). Mirrors sigma-rust
   * `read_scalar` (sig_serializer.rs:250-255):
   *
   *   let mut scalar_bytes = [0; GROUP_SIZE];
   *   let bytes_read = r.read(&mut scalar_bytes)?;
   *   scalar_bytes.rotate_right(GROUP_SIZE - bytes_read);
   *
   * If fewer than 32 bytes remain we read everything available and left-pad
   * the result with zeros (prover stripped leading zero bytes). Always
   * returns exactly `SCALAR_BYTES` bytes; never throws.
   */
  readScalarBytes(): Uint8Array {
    const buf = new Uint8Array(SCALAR_BYTES)
    const available = Math.min(this.remaining(), SCALAR_BYTES)
    if (available > 0) {
      buf.set(this.bytes.subarray(this.pos, this.pos + available), SCALAR_BYTES - available)
      this.pos += available
    }
    return buf
  }

  /**
   * Read the next `n` bytes and return a defensive copy.
   *
   * Used by the Cthreshold verifier walk to read the `(n-k)*24`
   * polynomial bytes inline in the proof stream.
   *
   * Throws `'truncated-signature'` on underrun.
   */
  readBytes(n: number): Uint8Array {
    return this.readN(n)
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
