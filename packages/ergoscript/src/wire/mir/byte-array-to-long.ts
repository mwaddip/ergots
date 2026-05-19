/**
 * ByteArrayToLong — parse + serialize.
 *
 * Wire format (sigma-rust `mir/byte_array_to_long.rs`):
 *
 *   [OP_BYTE_ARRAY_TO_LONG opcode = 0x7c]
 *   [input: Expr]
 *
 * Interprets the first 8 bytes of a byte array as a big-endian signed
 * SLong. Follows sigma-rust's `OneArgOp` + `OneArgOpTryBuild` pattern
 * (`mir/unary_op.rs:26-36`): a single inner Expr is parsed / serialized
 * after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-`SColl(SByte)` inputs
 * (`mir/byte_array_to_long.rs:43-49`). We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass (same convention
 * as Negation / BitInversion / BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/byte_array_to_long.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (BYTE_ARRAY_TO_LONG = 124)
 */

import type { ByteArrayToLong, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `ByteArrayToLong` payload (the OP_BYTE_ARRAY_TO_LONG opcode
 * byte was consumed by the dispatcher). Reads one Expr — the input byte
 * array.
 *
 * Mirrors sigma-rust's
 * `<ByteArrayToLong as SigmaSerializable>::sigma_parse` via the
 * `OneArgOp` blanket impl.
 */
export function parseByteArrayToLong(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): ByteArrayToLong {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'ByteArrayToLong', input }
}

/**
 * Serialize a `ByteArrayToLong` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_BYTE_ARRAY_TO_LONG opcode byte).
 * Writes the input Expr.
 */
export function serializeByteArrayToLong(
  b: ByteArrayToLong,
  w: ByteWriter
): void {
  serializeExpr(b.input, w)
}
