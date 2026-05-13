/**
 * SigmaPropIsProven — parse + serialize.
 *
 * Wire format (sigma-rust `mir/sigma_prop_is_proven.rs`):
 *
 *   [OP_SIGMA_PROP_IS_PROVEN opcode = 0xcf]
 *   [input: Expr]                          -- SSigmaProp
 *
 * Represents the execution of the Sigma protocol that validates the given
 * `SigmaProp`; result type is `SBoolean`. Follows sigma-rust's `OneArgOp` +
 * `OneArgOpTryBuild` pattern (`mir/unary_op.rs:26-36`): a single inner Expr
 * is parsed / serialized after the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-`SSigmaProp` inputs
 * (`mir/sigma_prop_is_proven.rs:39-45`). We do NOT enforce that at the wire
 * layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/sigma_prop_is_proven.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::SIGMA_PROP_IS_PROVEN = new_op_code(95) → 112 + 95 = 207 = 0xcf)
 */

import type { SigmaPropIsProven, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `SigmaPropIsProven` payload (the OP_SIGMA_PROP_IS_PROVEN opcode
 * byte was consumed by the dispatcher). Reads one Expr — the input
 * SigmaProp.
 *
 * Mirrors sigma-rust's `<SigmaPropIsProven as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseSigmaPropIsProven(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): SigmaPropIsProven {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'SigmaPropIsProven', input }
}

/**
 * Serialize a `SigmaPropIsProven` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_SIGMA_PROP_IS_PROVEN opcode byte).
 * Writes the input Expr.
 */
export function serializeSigmaPropIsProven(
  s: SigmaPropIsProven,
  w: ByteWriter
): void {
  serializeExpr(s.input, w)
}
