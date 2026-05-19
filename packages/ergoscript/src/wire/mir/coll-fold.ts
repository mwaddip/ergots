/**
 * CollFold — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_fold.rs`):
 *
 *   [OP_FOLD opcode = 0xb0]
 *   [input: Expr]    -- the source collection (SColl)
 *   [zero: Expr]     -- the initial accumulator value
 *   [fold_op: Expr]  -- the fold function: SFunc taking (Tuple(zero_tpe, elem_tpe)) → zero_tpe
 *
 * Fold applies `fold_op` to the start value `zero` and each element of
 * `input` from left to right. The wire payload is three back-to-back Exprs
 * parsed recursively via the central dispatcher.
 *
 * Note on the `fold_op` shape: sigma-rust's `Fold::new` requires `fold_op`'s
 * single domain type to equal `STuple(zero.tpe(), elem.tpe())` — that is,
 * the lambda takes a single 2-tuple argument that gets destructured to
 * `(acc, elem)`. We do NOT enforce that at the wire layer — type-shape
 * checks belong to a later pass (`mir/coll_fold.rs:30-58`).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_fold.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::FOLD)
 */

import type { Fold, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `Fold` payload (the OP_FOLD opcode byte was consumed by the
 * dispatcher). Reads the input collection Expr, the zero Expr, then the
 * fold_op Expr.
 *
 * Mirrors sigma-rust's `<Fold as SigmaSerializable>::sigma_parse`
 * (`mir/coll_fold.rs:76-85`). Note sigma-rust's parser bypasses `Fold::new`
 * and constructs the struct directly, so the parse path is permissive on
 * type-shape; our wire parser is permissive for the same reason.
 */
export function parseCollFold(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Fold {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const zero = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const foldOp = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'Fold', input, zero, foldOp }
}

/**
 * Serialize a `Fold` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_FOLD opcode byte). Writes the input Expr, then the zero
 * Expr, then the fold_op Expr.
 */
export function serializeCollFold(e: Fold, w: ByteWriter): void {
  serializeExpr(e.input, w)
  serializeExpr(e.zero, w)
  serializeExpr(e.foldOp, w)
}
