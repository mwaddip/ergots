/**
 * `VerifyError` — typed failure surface for `verifySignature` and the
 * sigma-protocol verifier infrastructure (phase 2g-medium).
 *
 * Distinct from `EvalError` (which is for eval-time arm failures); the
 * verifier is a separate public function and surface area.
 *
 * Codes:
 *   - 'conjecture-not-implemented'  — Cand/Cor/Cthreshold input (deferred to 2g-combinators)
 *   - 'empty-signature'             — signature byte sequence is empty
 *   - 'truncated-signature'         — signature ran out of bytes before tree walk completed
 *   - 'point-not-on-curve'          — SEC1 decode rejected a leaf's pubkey/component
 *   - 'scalar-out-of-range'         — z scalar read from signature is >= group order n
 */

export class VerifyError extends Error {
  constructor(
    message: string,
    public readonly code: VerifyErrorCode
  ) {
    super(message)
    this.name = 'VerifyError'
  }
}

export type VerifyErrorCode =
  | 'conjecture-not-implemented'
  | 'empty-signature'
  | 'truncated-signature'
  | 'point-not-on-curve'
  // 'scalar-out-of-range' is declared but currently not thrown — `scalarFromBytes`
  // reduces mod n silently (matching sigma-rust's `Scalar::reduce_bytes` posture
  // at `wscalar.rs:60-67`). Reserved for a future slice that wants to surface
  // raw-bytes-≥-n as a typed throw per Decision #6 in the design spec.
  | 'scalar-out-of-range'
