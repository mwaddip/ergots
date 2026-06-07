/**
 * XorOf — parse + serialize.
 *
 * Wire format (sigma-rust `mir/xor_of.rs`):
 *
 *   [OP_XOR_OF opcode = 0xff]
 *   [input: Expr]
 *
 * `XorOf` is the logical XOR across a *collection* of booleans
 * (`Coll[SBoolean] → SBoolean`), distinct from `Xor` (byte-array XOR, opcode
 * 0x9b) and `BinOp(LogicalOp::Xor)` (binary boolean XOR, opcode 0xf4). The
 * wire payload is a single Expr that evaluates to `Coll[SBoolean]`. We do
 * NOT enforce the element type at the wire layer.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/xor_of.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:201
 */

import type { XorOf, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `XorOf` payload (the OP_XOR_OF opcode byte was consumed by the
 * dispatcher). Reads one Expr — the input collection.
 *
 * Mirrors sigma-rust's `XorOf::sigma_parse`.
 */
export function parseXorOf(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): XorOf {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'XorOf', input }
}

/**
 * Serialize a `XorOf` payload (the dispatcher in {@link serializeExpr} emits
 * the OP_XOR_OF opcode byte). Writes the input Expr.
 */
export function serializeXorOf(x: XorOf, w: ByteWriter, treeVersion: number): void {
  serializeExpr(x.input, w, treeVersion)
}
