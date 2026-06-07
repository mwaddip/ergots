/**
 * ByteArrayToBigInt — parse + serialize.
 *
 * Wire format (sigma-rust `mir/byte_array_to_bigint.rs`):
 *
 *   [OP_BYTE_ARRAY_TO_BIGINT opcode = 0x7b]
 *   [input: Expr]
 *
 * Interprets a byte array as a big-endian two's-complement signed
 * SBigInt. Follows sigma-rust's `OneArgOp` + `OneArgOpTryBuild` pattern
 * (`mir/unary_op.rs:26-36`): a single inner Expr is parsed / serialized
 * after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-`SColl(SByte)` inputs
 * (`mir/byte_array_to_bigint.rs:43-49`). We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass (same convention
 * as Negation / BitInversion / BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/byte_array_to_bigint.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (BYTE_ARRAY_TO_BIGINT = 123)
 */

import type { ByteArrayToBigInt, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `ByteArrayToBigInt` payload (the OP_BYTE_ARRAY_TO_BIGINT
 * opcode byte was consumed by the dispatcher). Reads one Expr — the
 * input byte array.
 *
 * Mirrors sigma-rust's
 * `<ByteArrayToBigInt as SigmaSerializable>::sigma_parse` via the
 * `OneArgOp` blanket impl.
 */
export function parseByteArrayToBigInt(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): ByteArrayToBigInt {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'ByteArrayToBigInt', input }
}

/**
 * Serialize a `ByteArrayToBigInt` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_BYTE_ARRAY_TO_BIGINT opcode byte).
 * Writes the input Expr.
 */
export function serializeByteArrayToBigInt(
  b: ByteArrayToBigInt,
  w: ByteWriter,
  treeVersion: number
): void {
  serializeExpr(b.input, w, treeVersion)
}
