/**
 * `VerifyError` — typed failure surface for `verifySignature` and the
 * sigma-protocol verifier infrastructure (phase 2g-medium / 2g-combinators).
 *
 * Distinct from `EvalError` (which is for eval-time arm failures); the
 * verifier is a separate public function and surface area.
 *
 * Codes:
 *   - 'conjecture-not-implemented'        — RESERVED. Was thrown in 2g-medium for
 *                                            Cand/Cor/Cthreshold inputs. As of
 *                                            2g-combinators (Task 9) the verifier
 *                                            handles all conjectures; this code
 *                                            is never thrown but kept declared
 *                                            for ABI stability with prior callers.
 *   - 'empty-signature'                   — signature byte sequence is empty
 *   - 'truncated-signature'               — signature ran out of bytes before tree walk completed
 *   - 'point-not-on-curve'                — SEC1 decode rejected a leaf's pubkey/component
 *   - 'scalar-out-of-range'               — z scalar read from signature is >= group order n
 *   - 'cthreshold-polynomial-bytes-mismatch' — Cthreshold polynomial bytes wrong size for tree shape
 *   - 'cor-derived-challenge-mismatch'    — RESERVED for a future strict-check pass that
 *                                            would compare a Cor's XOR-derived last-child
 *                                            challenge against an explicit on-wire value.
 *                                            The 2g-combinators verifier mirrors sigma-rust:
 *                                            the last child's challenge is computed (not read)
 *                                            via XOR, so this code is never thrown today.
 *   - 'cthreshold-derived-challenge-mismatch' — RESERVED. Symmetric reservation for a future
 *                                                strict-check on Cthreshold children. The
 *                                                2g-combinators verifier derives every child
 *                                                challenge by polynomial evaluation (never
 *                                                read from the proof), so this code is never
 *                                                thrown today.
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
  // RESERVED — no longer thrown as of phase 2g-combinators (Task 9). Kept for
  // ABI stability with callers that pattern-matched on this code in 2g-medium.
  | 'conjecture-not-implemented'
  | 'empty-signature'
  | 'truncated-signature'
  | 'point-not-on-curve'
  // 'scalar-out-of-range' is declared but currently not thrown — `scalarFromBytes`
  // reduces mod n silently (matching sigma-rust's `Scalar::reduce_bytes` posture
  // at `wscalar.rs:60-67`). Reserved for a future slice that wants to surface
  // raw-bytes-≥-n as a typed throw per Decision #6 in the design spec.
  | 'scalar-out-of-range'
  // 'cthreshold-polynomial-bytes-mismatch' fires when the tree shape implies
  // (n-k)*24 polynomial bytes but the buffer is shorter, or when the tree shape
  // implies a negative coefficient count (k > n). Thrown by the Cthreshold parse
  // path in `verifier.ts::parseCheckedTree`.
  | 'cthreshold-polynomial-bytes-mismatch'
  // RESERVED — see header comments. Not thrown by 2g-combinators today but
  // declared so future strict-check passes have a typed surface.
  | 'cor-derived-challenge-mismatch'
  | 'cthreshold-derived-challenge-mismatch'
  // 'invalid-sigma-tree' fires when verifySignature is invoked on a
  // hand-constructed SigmaBoolean whose structure violates wire-format
  // invariants — Cand / Cor / Cthreshold with zero children, or Cthreshold
  // with k < 1. The wire parser enforces these invariants (see facts/
  // ergoscript-wire.md `SigmaBooleanParseError` codes); the verifier check
  // covers hand-built values that bypass parse. Audit ERG-01.
  | 'invalid-sigma-tree'
