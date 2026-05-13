/**
 * Exponentiate — parse + serialize.
 *
 * Wire format (sigma-rust `mir/exponentiate.rs`):
 *
 *   [OP_EXPONENTIATE opcode = 0x9f]
 *   [left: Expr]     -- SGroupElement
 *   [right: Expr]    -- SBigInt (exponent)
 *
 * Computes `left ^ right` in the secp256k1 group: `left` is a group element,
 * `right` is the scalar exponent. The wire payload is just two back-to-back
 * Exprs, parsed recursively via the central dispatcher.
 *
 * Sigma-rust's `Exponentiate::new` enforces `(SGroupElement, SBigInt)` on the
 * operands' post-eval types (`mir/exponentiate.rs:28-43`). We do NOT enforce
 * that at the wire layer — type-shape checks belong to a later pass (same
 * convention as Xor, BoolToSigmaProp, etc.). The wire-layer parser is
 * permissive: well-formed corpora produced by sigma-rust's serializer always
 * satisfy the type constraint, and the AST is sigma-rust-equivalent
 * regardless.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/exponentiate.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::EXPONENTIATE)
 */

import type { Exponentiate, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `Exponentiate` payload (the OP_EXPONENTIATE opcode byte was
 * consumed by the dispatcher). Reads the left (GroupElement) Expr then the
 * right (BigInt exponent) Expr.
 *
 * Mirrors sigma-rust's `<Exponentiate as SigmaSerializable>::sigma_parse`
 * (`mir/exponentiate.rs:60-64`).
 */
export function parseExponentiate(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Exponentiate {
  const left = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const right = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'Exponentiate', left, right }
}

/**
 * Serialize an `Exponentiate` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_EXPONENTIATE opcode byte). Writes the left (GroupElement) Expr,
 * then the right (BigInt exponent) Expr.
 */
export function serializeExponentiate(e: Exponentiate, w: ByteWriter): void {
  serializeExpr(e.left, w)
  serializeExpr(e.right, w)
}
