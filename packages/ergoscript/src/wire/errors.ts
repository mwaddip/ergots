/**
 * Error classes for the ergoscript wire-format layer.
 *
 * Centralized here so that per-variant modules in wire/mir/ can import
 * them without creating circular imports with parse.ts / serialize.ts
 * (the dispatchers that aggregate the variants). Mirrors the pattern
 * established by `packages/nipopow/src/errors.ts`.
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
