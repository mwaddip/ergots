/**
 * CollForall — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_forall.rs`):
 *
 *   [OP_FOR_ALL opcode = 0xaf]
 *   [input: Expr]      -- the source collection (SColl)
 *   [condition: Expr]  -- the predicate function (SFunc returning SBoolean)
 *
 * ForAll tests whether `condition(elem)` is true for EVERY element of
 * `input`. The wire payload is two back-to-back Exprs parsed recursively
 * via the central dispatcher.
 *
 * Sigma-rust's `ForAll::new` enforces post-eval typing: `input` must be
 * `SColl(elem)` and `condition` must be `SFunc` with a single arg of type
 * `elem` returning `SBoolean` (`mir/coll_forall.rs:30-55`). We do NOT
 * enforce that at the wire layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_forall.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::FOR_ALL)
 */

import type { ForAll, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `ForAll` payload (the OP_FOR_ALL opcode byte was consumed by the
 * dispatcher). Reads the input collection Expr, then the condition Expr.
 *
 * Mirrors sigma-rust's `<ForAll as SigmaSerializable>::sigma_parse`
 * (`mir/coll_forall.rs:73-77`).
 */
export function parseCollForall(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): ForAll {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const condition = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'ForAll', input, condition }
}

/**
 * Serialize a `ForAll` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_FOR_ALL opcode byte). Writes the input Expr, then the
 * condition Expr.
 */
export function serializeCollForall(e: ForAll, w: ByteWriter): void {
  serializeExpr(e.input, w)
  serializeExpr(e.condition, w)
}
