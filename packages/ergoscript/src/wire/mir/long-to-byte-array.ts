/**
 * LongToByteArray — parse + serialize.
 *
 * Wire format (sigma-rust `mir/long_to_byte_array.rs`):
 *
 *   [OP_LONG_TO_BYTE_ARRAY opcode = 0x7a]
 *   [input: Expr]
 *
 * Encodes an SLong as an 8-byte big-endian signed byte array. Follows
 * sigma-rust's `OneArgOp` + `OneArgOpTryBuild` pattern
 * (`mir/unary_op.rs:26-36`): a single inner Expr is parsed / serialized
 * after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-SLong inputs
 * (`mir/long_to_byte_array.rs:44-52`). We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass (same convention
 * as Negation / BitInversion / BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/long_to_byte_array.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (LONG_TO_BYTE_ARRAY = 122)
 */

import type { LongToByteArray, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `LongToByteArray` payload (the OP_LONG_TO_BYTE_ARRAY opcode
 * byte was consumed by the dispatcher). Reads one Expr — the input
 * SLong value.
 *
 * Mirrors sigma-rust's
 * `<LongToByteArray as SigmaSerializable>::sigma_parse` via the
 * `OneArgOp` blanket impl.
 */
export function parseLongToByteArray(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): LongToByteArray {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'LongToByteArray', input }
}

/**
 * Serialize a `LongToByteArray` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_LONG_TO_BYTE_ARRAY opcode byte).
 * Writes the input Expr.
 */
export function serializeLongToByteArray(
  l: LongToByteArray,
  w: ByteWriter
): void {
  serializeExpr(l.input, w)
}
