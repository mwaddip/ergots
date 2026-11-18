/**
 * Error classes for the ergoscript wire-format layer.
 *
 * Centralized here so that per-variant modules in wire/mir/ can import
 * them without creating circular imports with parse.ts / serialize.ts
 * (the dispatchers that aggregate the variants). Mirrors the pattern
 * established by `packages/nipopow/src/errors.ts`.
 *
 * Current `ExprSerializeError` codes include the write-side field bounds
 * (`get-var-id-out-of-range`, `tagged-variable-id-out-of-range`,
 * `deserialize-register-id-out-of-range`, `extract-register-as-id-out-of-range`,
 * `method-call-id-out-of-range`, `property-call-id-out-of-range`,
 * `select-field-index-out-of-range`, `collection-size-out-of-range`,
 * `tuple-arity-out-of-range`, `fun-def-tpe-args-out-of-range`,
 * `func-value-arg-id-out-of-range`, `val-use-id-out-of-range`,
 * `val-def-id-out-of-range`, `deserialize-context-id-out-of-range`),
 * `not-supported` (ZkProofBlock), `collection-item-not-boolean-constant`,
 * `property-call-missing-type-arg`, `method-call-missing-type-arg`,
 * `unknown-binop-kind` and `unknown-variant` (the compile-time-unreachable
 * default of `serializeExpr`'s exhaustive switch). See
 * `facts/ergoscript-wire.md` "Error taxonomy" for the full list.
 */

export class ExprParseError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ExprParseError'
  }
}

export class ExprSerializeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ExprSerializeError'
  }
}
