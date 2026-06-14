/**
 * SigmaAnd — parse + serialize.
 *
 * Wire format (sigma-rust `mir/sigma_and.rs`):
 *
 *   [OP_SIGMA_AND opcode = 0xea]
 *   [items_count: VLQ-u32]              -- length of the items vector
 *   [item_0: Expr] ... [item_n-1: Expr] -- each an SSigmaProp
 *
 * AND conjunction over a collection of `SSigmaProp` propositions. The items
 * are serialized through `Vec<Expr>::sigma_serialize`
 * (`serialization/serializable.rs:172-186`), which emits a VLQ-encoded u32
 * length followed by each Expr.
 *
 * Sigma-rust models the items collection as `SigmaConjectureItems<Expr> =
 * BoundedVec<Expr, 1, 255>` — at least 1, at most 255. The bounds are enforced
 * by `SigmaAnd::new` (`mir/sigma_and.rs:24-50`) via the `BoundedVec` try_into.
 * We do NOT enforce that at the wire layer — type-shape / arity checks belong
 * to a later pass; well-formed corpora from sigma-rust always satisfy them.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/sigma_and.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean.rs
 *     (`SigmaConjectureItems<T> = BoundedVec<T, 1, 255>`)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::SIGMA_AND = new_op_code(122) → 112 + 122 = 234 = 0xea)
 *   ~/projects/sigma-rust/sigma-rust/sigma-ser/src/vlq_encode.rs:77-80
 *     (`put_u32` → VLQ via `put_u64`)
 */

import type { Expr, SigmaAnd, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `SigmaAnd` payload (the OP_SIGMA_AND opcode byte was consumed by
 * the dispatcher). Reads a VLQ-u32 item count followed by that many Exprs.
 *
 * Mirrors sigma-rust's `<SigmaAnd as SigmaSerializable>::sigma_parse`
 * (`mir/sigma_and.rs:67-69`) and the `Vec<T>::sigma_parse` impl
 * (`serialization/serializable.rs:178-185`).
 */
export function parseSigmaAnd(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): SigmaAnd {
  const count = r.readVlqU()
  const items: Expr[] = []
  for (let i = 0; i < count; i++) {
    items.push(parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion))
  }
  return { tag: 'SigmaAnd', items }
}

/**
 * Serialize a `SigmaAnd` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_SIGMA_AND opcode byte). Writes a VLQ-u32 item count followed
 * by each Expr.
 *
 * Mirrors sigma-rust's `<SigmaAnd as SigmaSerializable>::sigma_serialize`
 * (`mir/sigma_and.rs:63-65`) and the `Vec<T>::sigma_serialize` impl
 * (`serialization/serializable.rs:173-176`).
 */
export function serializeSigmaAnd(e: SigmaAnd, w: ByteWriter, treeVersion: number): void {
  w.writeVlqU(e.items.length)
  for (const item of e.items) {
    serializeExpr(item, w, treeVersion)
  }
}
