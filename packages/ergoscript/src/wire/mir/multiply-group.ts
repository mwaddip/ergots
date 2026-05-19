/**
 * MultiplyGroup — parse + serialize.
 *
 * Wire format (sigma-rust `mir/multiply_group.rs`):
 *
 *   [OP_MULTIPLY_GROUP opcode = 0xa0]
 *   [left: Expr]     -- SGroupElement
 *   [right: Expr]    -- SGroupElement
 *
 * Computes the group product `left * right` in the secp256k1 group (both
 * operands are group elements). The wire payload is just two back-to-back
 * Exprs, parsed recursively via the central dispatcher.
 *
 * Sigma-rust's `MultiplyGroup::new` enforces `(SGroupElement, SGroupElement)`
 * on the operands' post-eval types (`mir/multiply_group.rs:28-43`). We do NOT
 * enforce that at the wire layer — type-shape checks belong to a later pass
 * (same convention as Xor, BoolToSigmaProp, etc.). The wire-layer parser is
 * permissive: well-formed corpora produced by sigma-rust's serializer always
 * satisfy the type constraint, and the AST is sigma-rust-equivalent
 * regardless.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/multiply_group.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::MULTIPLY_GROUP)
 */

import type { MultiplyGroup, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `MultiplyGroup` payload (the OP_MULTIPLY_GROUP opcode byte was
 * consumed by the dispatcher). Reads the left (GroupElement) Expr then the
 * right (GroupElement) Expr.
 *
 * Mirrors sigma-rust's `<MultiplyGroup as SigmaSerializable>::sigma_parse`
 * (`mir/multiply_group.rs:60-64`).
 */
export function parseMultiplyGroup(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): MultiplyGroup {
  const left = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const right = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'MultiplyGroup', left, right }
}

/**
 * Serialize a `MultiplyGroup` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_MULTIPLY_GROUP opcode byte). Writes the left (GroupElement)
 * Expr, then the right (GroupElement) Expr.
 */
export function serializeMultiplyGroup(e: MultiplyGroup, w: ByteWriter): void {
  serializeExpr(e.left, w)
  serializeExpr(e.right, w)
}
