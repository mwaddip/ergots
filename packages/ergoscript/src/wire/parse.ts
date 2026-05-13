/**
 * Expr wire-format parser — stub for Task 8.
 *
 * The full opcode-dispatch table is fleshed out in Task 9 and onward (one
 * opcode at a time, each behind its own RED-GREEN-REFACTOR cycle). For
 * Task 8 the envelope parser (`parseTree`) must be wired up to *something*
 * that consumes the body bytes, but no Expr opcode has been ported yet, so
 * every entry into this module throws `ExprParseError` with code
 * `not-implemented-yet`.
 *
 * Why a stub here rather than deferring envelope wiring entirely:
 * we want `parseTree` to be functionally complete for envelope edge cases
 * (empty/oversized inputs, header byte parsing, segregated-constants parsing)
 * from Task 8 onward. Tests that exercise those edges read the header,
 * then either return successfully (for failure cases caught before body
 * parsing — empty input, oversized input) or throw the well-known
 * `not-implemented-yet` code that confirms the envelope was parsed
 * successfully and the cursor reached the body. The latter pattern lets
 * envelope tests survive unchanged as Task 9+ fleshes out individual
 * opcodes.
 */

import type { Expr, SType, SValue } from '../mir/types'
import { ByteReader } from './reader'

export class ExprParseError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ExprParseError'
  }
}

/**
 * Parse a single Expr node from the reader. Task 9 fleshes out the
 * opcode dispatch table; until then every opcode throws.
 *
 * `constantTypes` and `constantValues` are passed through so the eventual
 * `ConstantPlaceholder` opcode can resolve placeholders against the
 * surrounding tree's segregated constants. Unused in the stub.
 */
export function parseExpr(
  r: ByteReader,
  // Constant-segregation lookups; consumed by the (not-yet-implemented)
  // `ConstantPlaceholder` opcode. Suppress the unused-parameter warning at
  // the signature level — the dispatch table in Task 9+ will use them.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _constantTypes: SType[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _constantValues: SValue[]
): Expr {
  const opcode = r.readU8()
  throw new ExprParseError(
    `Opcode 0x${opcode.toString(16).padStart(2, '0')} not implemented yet (Task 9+)`,
    'not-implemented-yet'
  )
}
