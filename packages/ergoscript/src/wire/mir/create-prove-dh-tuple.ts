/**
 * CreateProveDhTuple — parse + serialize.
 *
 * Wire format (sigma-rust `mir/create_prove_dh_tuple.rs`):
 *
 *   [OP_PROVE_DIFFIE_HELLMAN_TUPLE opcode = 0xce]
 *   [g: Expr]   -- SGroupElement (generator)
 *   [h: Expr]   -- SGroupElement (g^x)
 *   [u: Expr]   -- SGroupElement (g^y)
 *   [v: Expr]   -- SGroupElement (g^xy)
 *
 * Constructs a Diffie-Hellman tuple proposition from four GroupElements.
 * Each Expr is parsed / serialized in order, recursively via the central
 * dispatcher.
 *
 * Sigma-rust's `CreateProveDhTuple::new` enforces SGroupElement for every
 * input (`mir/create_prove_dh_tuple.rs:30-43`). We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_prove_dh_tuple.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::PROVE_DIFFIE_HELLMAN_TUPLE = new_op_code(94) → 112 + 94 = 206 = 0xce)
 */

import type { CreateProveDhTuple, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `CreateProveDhTuple` payload (the OP_PROVE_DIFFIE_HELLMAN_TUPLE
 * opcode byte was consumed by the dispatcher). Reads four Exprs in order:
 * g, h, u, v — each an SGroupElement.
 *
 * Mirrors sigma-rust's `<CreateProveDhTuple as SigmaSerializable>::sigma_parse`
 * (`mir/create_prove_dh_tuple.rs:65-71`).
 */
export function parseCreateProveDhTuple(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): CreateProveDhTuple {
  const g = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const h = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const u = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const v = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'CreateProveDhTuple', g, h, u, v }
}

/**
 * Serialize a `CreateProveDhTuple` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_PROVE_DIFFIE_HELLMAN_TUPLE opcode byte).
 * Writes the four GroupElement Exprs in order: g, h, u, v.
 *
 * Mirrors sigma-rust's `<CreateProveDhTuple as SigmaSerializable>::sigma_serialize`
 * (`mir/create_prove_dh_tuple.rs:57-63`).
 */
export function serializeCreateProveDhTuple(
  e: CreateProveDhTuple,
  w: ByteWriter
): void {
  serializeExpr(e.g, w)
  serializeExpr(e.h, w)
  serializeExpr(e.u, w)
  serializeExpr(e.v, w)
}
