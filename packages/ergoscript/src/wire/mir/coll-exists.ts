/**
 * CollExists — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_exists.rs`):
 *
 *   [OP_EXISTS opcode = 0xae]
 *   [input: Expr]      -- the source collection (SColl)
 *   [condition: Expr]  -- the predicate function (SFunc returning SBoolean)
 *
 * Exists tests whether `condition(elem)` is true for AT LEAST ONE element of
 * `input`. The wire payload is two back-to-back Exprs parsed recursively via
 * the central dispatcher.
 *
 * Sigma-rust's `Exists::new` enforces post-eval typing: `input` must be
 * `SColl(elem)` and `condition` must be `SFunc` with a single arg of type
 * `elem` returning `SBoolean` (`mir/coll_exists.rs:30-55`). We do NOT
 * enforce that at the wire layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_exists.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::EXISTS)
 */

import type { Exists, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `Exists` payload (the OP_EXISTS opcode byte was consumed by the
 * dispatcher). Reads the input collection Expr, then the condition Expr.
 *
 * Mirrors sigma-rust's `<Exists as SigmaSerializable>::sigma_parse`
 * (`mir/coll_exists.rs:73-77`).
 */
export function parseCollExists(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): Exists {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const condition = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'Exists', input, condition }
}

/**
 * Serialize an `Exists` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_EXISTS opcode byte). Writes the input Expr, then the
 * condition Expr.
 */
export function serializeCollExists(e: Exists, w: ByteWriter, treeVersion: number): void {
  serializeExpr(e.input, w, treeVersion)
  serializeExpr(e.condition, w, treeVersion)
}
