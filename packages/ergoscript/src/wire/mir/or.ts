/**
 * Or — parse + serialize.
 *
 * Wire format (sigma-rust `mir/or.rs`):
 *
 *   [OP_OR opcode = 0x97]
 *   [input: Expr]
 *
 * `Or` is the logical OR across a *collection* of booleans
 * (`Coll[SBoolean] → SBoolean`), distinct from the binary `||` operator
 * (which is encoded as a `BinOp` with `LogicalOp::Or`, opcode 0xee). The
 * wire payload is a single Expr that evaluates to `Coll[SBoolean]`. We do
 * NOT enforce the element type at the wire layer.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/or.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:168
 */

import type { Or, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `Or` payload (the OP_OR opcode byte was consumed by the
 * dispatcher). Reads one Expr — the input collection.
 *
 * Mirrors sigma-rust's `Or::sigma_parse`.
 */
export function parseOr(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Or {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'Or', input }
}

/**
 * Serialize an `Or` payload (the dispatcher in {@link serializeExpr} emits
 * the OP_OR opcode byte). Writes the input Expr.
 */
export function serializeOr(o: Or, w: ByteWriter): void {
  serializeExpr(o.input, w)
}
