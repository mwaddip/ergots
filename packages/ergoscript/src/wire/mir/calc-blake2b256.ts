/**
 * CalcBlake2b256 — parse + serialize.
 *
 * Wire format (sigma-rust `mir/calc_blake2b256.rs`):
 *
 *   [OP_CALC_BLAKE2B256 opcode = 0xcb]
 *   [input: Expr]
 *
 * Computes the Blake2b-256 hash of a byte array. Follows sigma-rust's
 * `OneArgOp` + `OneArgOpTryBuild` pattern (`mir/unary_op.rs:26-36`): a
 * single inner Expr is parsed / serialized after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-`SColl(SByte)` inputs
 * (`mir/calc_blake2b256.rs:43-49`). We do NOT enforce that at the wire
 * layer — type-shape checks belong to a later pass (same convention as
 * Negation / BitInversion / BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/calc_blake2b256.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (CALC_BLAKE2B256 = 203)
 */

import type { CalcBlake2b256, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `CalcBlake2b256` payload (the OP_CALC_BLAKE2B256 opcode byte
 * was consumed by the dispatcher). Reads one Expr — the input byte
 * array.
 *
 * Mirrors sigma-rust's `<CalcBlake2b256 as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseCalcBlake2b256(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): CalcBlake2b256 {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'CalcBlake2b256', input }
}

/**
 * Serialize a `CalcBlake2b256` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_CALC_BLAKE2B256 opcode byte). Writes
 * the input Expr.
 */
export function serializeCalcBlake2b256(
  c: CalcBlake2b256,
  w: ByteWriter,
  treeVersion: number
): void {
  serializeExpr(c.input, w, treeVersion)
}
