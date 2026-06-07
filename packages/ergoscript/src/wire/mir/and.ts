/**
 * And — parse + serialize.
 *
 * Wire format (sigma-rust `mir/and.rs`):
 *
 *   [OP_AND opcode = 0x96]
 *   [input: Expr]
 *
 * `And` is the logical AND across a *collection* of booleans
 * (`Coll[SBoolean] → SBoolean`), distinct from the binary `&&` operator
 * (which is encoded as a `BinOp` with `LogicalOp::And`, opcode 0xed). The
 * wire payload is a single Expr that evaluates to `Coll[SBoolean]`. We do
 * NOT enforce the element type at the wire layer (sigma-rust's parser
 * doesn't either — `mir/and.rs:40-45` simply reads one Expr).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/and.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:167
 */

import type { And, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `And` payload (the OP_AND opcode byte was consumed by the
 * dispatcher). Reads one Expr — the input collection.
 *
 * Mirrors sigma-rust's `And::sigma_parse`.
 */
export function parseAnd(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): And {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'And', input }
}

/**
 * Serialize an `And` payload (the dispatcher in {@link serializeExpr} emits
 * the OP_AND opcode byte). Writes the input Expr.
 */
export function serializeAnd(a: And, w: ByteWriter, treeVersion: number): void {
  serializeExpr(a.input, w, treeVersion)
}
