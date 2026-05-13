/**
 * CalcSha256 — parse + serialize.
 *
 * Wire format (sigma-rust `mir/calc_sha256.rs`):
 *
 *   [OP_CALC_SHA256 opcode = 0xcc]
 *   [input: Expr]
 *
 * Computes the SHA-256 hash of a byte array. Follows sigma-rust's
 * `OneArgOp` + `OneArgOpTryBuild` pattern (`mir/unary_op.rs:26-36`): a
 * single inner Expr is parsed / serialized after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-`SColl(SByte)` inputs
 * (`mir/calc_sha256.rs:43-49`). We do NOT enforce that at the wire
 * layer — type-shape checks belong to a later pass (same convention as
 * Negation / BitInversion / BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/calc_sha256.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (CALC_SHA256 = 204)
 */

import type { CalcSha256, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `CalcSha256` payload (the OP_CALC_SHA256 opcode byte was
 * consumed by the dispatcher). Reads one Expr — the input byte array.
 *
 * Mirrors sigma-rust's `<CalcSha256 as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseCalcSha256(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): CalcSha256 {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'CalcSha256', input }
}

/**
 * Serialize a `CalcSha256` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_CALC_SHA256 opcode byte). Writes the input Expr.
 */
export function serializeCalcSha256(c: CalcSha256, w: ByteWriter): void {
  serializeExpr(c.input, w)
}
