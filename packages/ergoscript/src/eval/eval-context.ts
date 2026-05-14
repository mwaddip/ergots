/**
 * Evaluator error class. Single class with a `code` field for programmatic
 * dispatch — same shape as `ProofParseError`/`ErgoTreeParseError` from
 * earlier phases. Codes enumerated in
 * `docs/specs/2026-05-14-ergoscript-phase-2b-design.md` § Error taxonomy.
 */
export class EvalError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'EvalError'
  }
}
