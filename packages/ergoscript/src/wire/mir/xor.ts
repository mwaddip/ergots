/**
 * Xor — parse + serialize.
 *
 * Wire format (sigma-rust `mir/xor.rs`):
 *
 *   [OP_XOR opcode = 0x9b]
 *   [left: Expr]
 *   [right: Expr]
 *
 * `Xor` is the byte-wise XOR of two `Coll[SByte]` operands — distinct from
 * the binary `^` operator on booleans (encoded as a `BinOp` with
 * `LogicalOp::Xor`, opcode 0xf4) and the threshold `XorOf` (over a
 * collection of booleans, opcode 0xff). Two Expr operands follow the opcode
 * byte; sigma-rust's parser (`mir/xor.rs:64-69`) calls `Xor::new` to
 * cross-check `Coll[SByte]` element types, but we accept whatever the wire
 * encodes — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/xor.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:169
 */

import type { Xor, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `Xor` payload (the OP_XOR opcode byte was consumed by the
 * dispatcher). Reads two Expr nodes back-to-back: left and right operands.
 *
 * Mirrors sigma-rust's `Xor::sigma_parse`.
 */
export function parseXor(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): Xor {
  const left = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const right = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'Xor', left, right }
}

/**
 * Serialize an `Xor` payload (the dispatcher in {@link serializeExpr} emits
 * the OP_XOR opcode byte). Writes left then right operands.
 */
export function serializeXor(x: Xor, w: ByteWriter, treeVersion: number): void {
  serializeExpr(x.left, w, treeVersion)
  serializeExpr(x.right, w, treeVersion)
}
