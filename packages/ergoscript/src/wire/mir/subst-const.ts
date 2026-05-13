/**
 * SubstConstants — parse + serialize.
 *
 * Wire format (sigma-rust `mir/subst_const.rs:64-78`):
 *
 *   [OP_SUBST_CONSTANTS opcode = 0x74]
 *   [scriptBytes: Expr]   -- post-eval type SColl(SByte)
 *   [positions: Expr]     -- post-eval type SColl(SInt)
 *   [newValues: Expr]     -- post-eval type SColl(T) for some T
 *
 * Three Expr nodes in order, no length prefix. Returns a `Coll[Byte]`: a copy
 * of `scriptBytes` (a serialized ergo tree with constant segregation) where
 * the constants at the given `positions` indexes are replaced with the
 * corresponding `newValues`. The return type is `SColl(SByte)`.
 *
 * Type-shape checks (`scriptBytes.tpe == SColl(SByte)`, `positions.tpe ==
 * SColl(SInt)`, `newValues.tpe == SColl(_)`) are sigma-rust constructor
 * invariants enforced by `SubstConstants::new` (`mir/subst_const.rs:35-54`).
 * We do NOT re-check those at the wire layer — same convention as Xor,
 * BoolToSigmaProp, etc. Well-formed corpora produced by sigma-rust's
 * serializer always satisfy the constraints; the AST is sigma-rust-equivalent
 * regardless.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/subst_const.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::SUBST_CONSTANTS = 0x74)
 */

import type { SubstConstants, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `SubstConstants` payload (the OP_SUBST_CONSTANTS opcode byte was
 * consumed by the dispatcher). Reads three back-to-back Exprs:
 * scriptBytes, positions, newValues.
 *
 * Mirrors sigma-rust's `<SubstConstants as SigmaSerializable>::sigma_parse`
 * (`mir/subst_const.rs:72-77`).
 */
export function parseSubstConstants(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): SubstConstants {
  const scriptBytes = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const positions = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const newValues = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'SubstConstants', scriptBytes, positions, newValues }
}

/**
 * Serialize a `SubstConstants` payload (the dispatcher in `serializeExpr`
 * emits the OP_SUBST_CONSTANTS opcode byte). Writes scriptBytes, positions,
 * and newValues Exprs in that order.
 *
 * Mirrors sigma-rust's `<SubstConstants as SigmaSerializable>::sigma_serialize`
 * (`mir/subst_const.rs:65-69`).
 */
export function serializeSubstConstants(
  e: SubstConstants,
  w: ByteWriter
): void {
  serializeExpr(e.scriptBytes, w)
  serializeExpr(e.positions, w)
  serializeExpr(e.newValues, w)
}
