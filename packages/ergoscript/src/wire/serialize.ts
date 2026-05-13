/**
 * Expr wire-format serializer — stub for Task 8.
 *
 * Mirror of {@link parseExpr}: the full opcode dispatch lands in Task 9+;
 * for Task 8 every call throws so `serializeTree` can be wired against a
 * real symbol even though no opcode has been ported. See `parse.ts` for
 * rationale.
 */

import type { Expr } from '../mir/types'
import { ByteWriter } from './writer'

export class ExprSerializeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ExprSerializeError'
  }
}

export function serializeExpr(
  e: Expr,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _w: ByteWriter
): void {
  throw new ExprSerializeError(
    `Expr variant ${e.tag} not implemented yet (Task 9+)`,
    'not-implemented-yet'
  )
}
