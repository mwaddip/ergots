/**
 * BoolToSigmaProp — parse + serialize.
 *
 * Wire format (sigma-rust `mir/bool_to_sigma.rs`):
 *
 *   [OP_BOOL_TO_SIGMA_PROP opcode = 0xd1]
 *   [input: Expr]
 *
 * Coerces a boolean expression to a SigmaProp (used e.g. inside
 * `atLeast(..., sigmaProp(boolExpr), ...)`). At runtime the result is either
 * the trivially-true or trivially-false SigmaProp. Follows sigma-rust's
 * `OneArgOp` + `OneArgOpTryBuild` pattern (`mir/unary_op.rs:26-36`): a
 * single inner Expr is parsed / serialized after the opcode byte.
 *
 * Sigma-rust's `try_build` skips type-checking the input deliberately —
 * older interpreters (v4.0) accepted a `SigmaProp` argument here, so the
 * input tpe is left unchecked at parse time (`mir/bool_to_sigma.rs:43-49`).
 * We mirror that — wire-layer accepts any Expr.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/bool_to_sigma.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:177
 */

import type { BoolToSigmaProp, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `BoolToSigmaProp` payload (the OP_BOOL_TO_SIGMA_PROP opcode byte
 * was consumed by the dispatcher). Reads one Expr — the input.
 *
 * Mirrors sigma-rust's `<BoolToSigmaProp as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseBoolToSigmaProp(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): BoolToSigmaProp {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'BoolToSigmaProp', input }
}

/**
 * Serialize a `BoolToSigmaProp` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_BOOL_TO_SIGMA_PROP opcode byte). Writes
 * the input Expr.
 */
export function serializeBoolToSigmaProp(
  b: BoolToSigmaProp,
  w: ByteWriter,
  treeVersion: number
): void {
  serializeExpr(b.input, w, treeVersion)
}
