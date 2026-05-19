/**
 * CollFilter — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_filter.rs`):
 *
 *   [OP_FILTER opcode = 0xb5]
 *   [input: Expr]      -- the source collection (SColl)
 *   [condition: Expr]  -- the predicate function (SFunc returning SBoolean)
 *
 * Filter retains elements of `input` for which `condition(elem)` is true.
 * The wire payload is two back-to-back Exprs parsed recursively via the
 * central dispatcher.
 *
 * Sigma-rust's `Filter::new` enforces post-eval typing: `input` must be
 * `SColl(elem)` and `condition` must be `SFunc` with a single arg of type
 * `elem` returning `SBoolean` (`mir/coll_filter.rs:30-55`). We do NOT
 * enforce that at the wire layer — type-shape checks belong to a later
 * pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_filter.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::FILTER)
 */

import type { Filter, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `Filter` payload (the OP_FILTER opcode byte was consumed by the
 * dispatcher). Reads the input collection Expr, then the condition Expr.
 *
 * Mirrors sigma-rust's `<Filter as SigmaSerializable>::sigma_parse`
 * (`mir/coll_filter.rs:73-77`).
 */
export function parseCollFilter(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Filter {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const condition = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'Filter', input, condition }
}

/**
 * Serialize a `Filter` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_FILTER opcode byte). Writes the input Expr, then the
 * condition Expr.
 */
export function serializeCollFilter(e: Filter, w: ByteWriter): void {
  serializeExpr(e.input, w)
  serializeExpr(e.condition, w)
}
