/**
 * CollSize — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_size.rs`):
 *
 *   [OP_SIZE_OF opcode = 0xb1]
 *   [input: Expr]      -- the collection whose size is requested
 *
 * SizeOf returns `SInt` — the number of elements in a `SColl`. The wire
 * payload is a single recursive Expr for the collection operand, identical
 * in shape to the unary box accessors and `Negation` / `LogicalNot`.
 *
 * Sigma-rust's `OneArgOpTryBuild::try_build` for `SizeOf` rejects inputs
 * whose post-eval type is not `SColl(_)` (`mir/coll_size.rs:39-50`). We do
 * NOT enforce that at the wire layer — type-shape checks belong to a later
 * pass (same convention as `ExtractAmount`, `Upcast`, etc.). The wire-layer
 * parser is permissive.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_size.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::SIZE_OF)
 */

import type { SizeOf, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `SizeOf` payload (the OP_SIZE_OF opcode byte was consumed by the
 * dispatcher). Reads a single input Expr.
 *
 * Mirrors sigma-rust's `SizeOf` via `OneArgOp` (`unary_op.rs`).
 */
export function parseCollSize(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): SizeOf {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'SizeOf', input }
}

/**
 * Serialize a `SizeOf` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_SIZE_OF opcode byte). Writes only the input Expr.
 */
export function serializeCollSize(e: SizeOf, w: ByteWriter): void {
  serializeExpr(e.input, w)
}
