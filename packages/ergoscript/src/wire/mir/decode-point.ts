/**
 * DecodePoint — parse + serialize.
 *
 * Wire format (sigma-rust `mir/decode_point.rs`):
 *
 *   [OP_DECODE_POINT opcode = 0xee]
 *   [input: Expr]
 *
 * Decodes a byte array (33-byte SEC1-compressed) into an SGroupElement
 * (secp256k1 point). Follows sigma-rust's `OneArgOp` + `OneArgOpTryBuild`
 * pattern (`mir/unary_op.rs:26-36`): a single inner Expr is parsed /
 * serialized after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-`SColl(SByte)` inputs
 * (`mir/decode_point.rs:42-49`). We do NOT enforce that at the wire
 * layer — type-shape checks belong to a later pass (same convention as
 * Negation / BitInversion / BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/decode_point.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (DECODE_POINT = 238)
 */

import type { DecodePoint, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `DecodePoint` payload (the OP_DECODE_POINT opcode byte was
 * consumed by the dispatcher). Reads one Expr — the input byte array.
 *
 * Mirrors sigma-rust's `<DecodePoint as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseDecodePoint(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): DecodePoint {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'DecodePoint', input }
}

/**
 * Serialize a `DecodePoint` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_DECODE_POINT opcode byte). Writes
 * the input Expr.
 */
export function serializeDecodePoint(d: DecodePoint, w: ByteWriter): void {
  serializeExpr(d.input, w)
}
