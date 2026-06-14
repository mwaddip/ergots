/**
 * Negation — parse + serialize.
 *
 * Wire format (sigma-rust `mir/negation.rs`):
 *
 *   [OP_NEGATION opcode = 0xf0]
 *   [input: Expr]
 *
 * Negation is the arithmetic unary minus on a numeric input (SByte, SShort,
 * SInt, SLong, SBigInt). It follows sigma-rust's `OneArgOp` +
 * `OneArgOpTryBuild` pattern (`mir/unary_op.rs:26-36`): a single inner
 * Expr is parsed / serialized after the opcode byte.
 *
 * Sigma-rust's `try_build` for Negation rejects non-numeric inputs (`if
 * !post_eval_tpe.is_numeric()` — `mir/negation.rs:40-47`). We do NOT enforce
 * that on the wire side — type-shape checks belong to a later pass; the
 * wire layer accepts whatever the bytes encode.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/negation.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:133
 */

import type { Negation, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `Negation` payload (the OP_NEGATION opcode byte was consumed by
 * the dispatcher). Reads one Expr — the input expression.
 *
 * Mirrors sigma-rust's `<Negation as SigmaSerializable>::sigma_parse` via
 * the `OneArgOp` blanket impl.
 */
export function parseNegation(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): Negation {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'Negation', input }
}

/**
 * Serialize a `Negation` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_NEGATION opcode byte). Writes the input Expr.
 */
export function serializeNegation(n: Negation, w: ByteWriter, treeVersion: number): void {
  serializeExpr(n.input, w, treeVersion)
}
