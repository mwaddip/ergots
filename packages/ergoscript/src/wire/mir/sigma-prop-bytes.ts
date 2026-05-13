/**
 * SigmaPropBytes — parse + serialize.
 *
 * Wire format (sigma-rust `mir/sigma_prop_bytes.rs`):
 *
 *   [OP_SIGMA_PROP_BYTES opcode = 0xd0]
 *   [input: Expr]                       -- SSigmaProp
 *
 * Extracts the serialized bytes of a `SigmaProp` value (result type
 * `Coll[SByte]`). Follows sigma-rust's `OneArgOp` + `OneArgOpTryBuild`
 * pattern (`mir/unary_op.rs:26-36`): a single inner Expr is parsed /
 * serialized after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-`SSigmaProp` inputs
 * (`mir/sigma_prop_bytes.rs:40-46`). We do NOT enforce that at the wire
 * layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/sigma_prop_bytes.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::SIGMA_PROP_BYTES = new_op_code(96) → 112 + 96 = 208 = 0xd0)
 */

import type { SigmaPropBytes, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `SigmaPropBytes` payload (the OP_SIGMA_PROP_BYTES opcode byte was
 * consumed by the dispatcher). Reads one Expr — the input SigmaProp.
 *
 * Mirrors sigma-rust's `<SigmaPropBytes as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseSigmaPropBytes(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): SigmaPropBytes {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'SigmaPropBytes', input }
}

/**
 * Serialize a `SigmaPropBytes` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_SIGMA_PROP_BYTES opcode byte). Writes
 * the input Expr.
 */
export function serializeSigmaPropBytes(
  s: SigmaPropBytes,
  w: ByteWriter
): void {
  serializeExpr(s.input, w)
}
