/**
 * CollAppend — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_append.rs`):
 *
 *   [OP_APPEND opcode = 0xb3]
 *   [input: Expr]    -- the first (left) collection
 *   [col_2: Expr]    -- the second (right) collection
 *
 * Append concatenates two collections of the same element type, producing
 * `input ++ col_2`. The wire payload is just two back-to-back Exprs, parsed
 * recursively via the central dispatcher.
 *
 * Sigma-rust's `Append::new` enforces that both inputs post-eval to
 * `SColl(elem)` with matching `elem` types (`mir/coll_append.rs:28-52`).
 * We do NOT enforce that at the wire layer — type-shape checks belong to a
 * later pass (same convention as the Task 16/17/18 variants). The wire-layer
 * parser is permissive: well-formed corpora produced by sigma-rust's
 * serializer always satisfy the type constraint, and the AST is sigma-rust-
 * equivalent regardless.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_append.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::APPEND)
 */

import type { Append, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `Append` payload (the OP_APPEND opcode byte was consumed by the
 * dispatcher). Reads the input Expr then the second collection Expr.
 *
 * Mirrors sigma-rust's `<Append as SigmaSerializable>::sigma_parse`
 * (`mir/coll_append.rs:74-78`).
 */
export function parseCollAppend(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Append {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const col2 = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'Append', input, col2 }
}

/**
 * Serialize an `Append` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_APPEND opcode byte). Writes the input Expr, then col_2.
 */
export function serializeCollAppend(e: Append, w: ByteWriter): void {
  serializeExpr(e.input, w)
  serializeExpr(e.col2, w)
}
