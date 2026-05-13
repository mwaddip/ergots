/**
 * SigmaOr — parse + serialize.
 *
 * Wire format (sigma-rust `mir/sigma_or.rs`):
 *
 *   [OP_SIGMA_OR opcode = 0xeb]
 *   [items_count: VLQ-u32]              -- length of the items vector
 *   [item_0: Expr] ... [item_n-1: Expr] -- each an SSigmaProp
 *
 * OR conjunction over a collection of `SSigmaProp` propositions. Identical
 * wire layout to {@link parseSigmaAnd} / {@link serializeSigmaAnd} but a
 * distinct opcode and tag. Items are serialized through
 * `Vec<Expr>::sigma_serialize` (`serialization/serializable.rs:172-186`),
 * which emits a VLQ-encoded u32 length followed by each Expr.
 *
 * Sigma-rust models the items collection as `SigmaConjectureItems<Expr> =
 * BoundedVec<Expr, 1, 255>` — at least 1, at most 255. The bounds are enforced
 * by `SigmaOr::new` (`mir/sigma_or.rs:24-50`) via the `BoundedVec` try_into.
 * We do NOT enforce that at the wire layer.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/sigma_or.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean.rs
 *     (`SigmaConjectureItems<T> = BoundedVec<T, 1, 255>`)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::SIGMA_OR = new_op_code(123) → 112 + 123 = 235 = 0xeb)
 */

import type { Expr, SigmaOr, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `SigmaOr` payload (the OP_SIGMA_OR opcode byte was consumed by the
 * dispatcher). Reads a VLQ-u32 item count followed by that many Exprs.
 *
 * Mirrors sigma-rust's `<SigmaOr as SigmaSerializable>::sigma_parse`
 * (`mir/sigma_or.rs:67-69`) and the `Vec<T>::sigma_parse` impl
 * (`serialization/serializable.rs:178-185`).
 */
export function parseSigmaOr(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): SigmaOr {
  const count = r.readVlqU()
  const items: Expr[] = []
  for (let i = 0; i < count; i++) {
    items.push(parseExpr(r, constantTypes, constantValues, valDefTypes))
  }
  return { tag: 'SigmaOr', items }
}

/**
 * Serialize a `SigmaOr` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_SIGMA_OR opcode byte). Writes a VLQ-u32 item count followed
 * by each Expr.
 *
 * Mirrors sigma-rust's `<SigmaOr as SigmaSerializable>::sigma_serialize`
 * (`mir/sigma_or.rs:63-65`) and the `Vec<T>::sigma_serialize` impl
 * (`serialization/serializable.rs:173-176`).
 */
export function serializeSigmaOr(e: SigmaOr, w: ByteWriter): void {
  w.writeVlqU(e.items.length)
  for (const item of e.items) {
    serializeExpr(item, w)
  }
}
