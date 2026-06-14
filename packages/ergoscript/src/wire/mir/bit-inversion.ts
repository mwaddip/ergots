/**
 * BitInversion — parse + serialize.
 *
 * Wire format (sigma-rust `mir/bit_inversion.rs`):
 *
 *   [OP_BIT_INVERSION opcode = 0xf1]
 *   [input: Expr]
 *
 * BitInversion is the bitwise NOT (~) on a numeric input (SByte, SShort,
 * SInt, SLong, SBigInt). Follows sigma-rust's `OneArgOp` +
 * `OneArgOpTryBuild` pattern (`mir/unary_op.rs:26-36`): a single inner Expr
 * is parsed / serialized after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-numeric inputs
 * (`mir/bit_inversion.rs:40-47`); we do NOT enforce that at the wire layer
 * — see the comment in logical-not.ts.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/bit_inversion.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:134
 */

import type { BitInversion, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `BitInversion` payload (the OP_BIT_INVERSION opcode byte was
 * consumed by the dispatcher). Reads one Expr — the input expression.
 *
 * Mirrors sigma-rust's `<BitInversion as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseBitInversion(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): BitInversion {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'BitInversion', input }
}

/**
 * Serialize a `BitInversion` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_BIT_INVERSION opcode byte). Writes the input Expr.
 */
export function serializeBitInversion(b: BitInversion, w: ByteWriter, treeVersion: number): void {
  serializeExpr(b.input, w, treeVersion)
}
