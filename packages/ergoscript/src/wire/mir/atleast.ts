/**
 * Atleast — parse + serialize.
 *
 * Wire format (sigma-rust `mir/atleast.rs`):
 *
 *   [OP_ATLEAST opcode = 0x98]
 *   [bound: Expr]
 *   [input: Expr]
 *
 * `Atleast` is the threshold-k composition over `Coll[SSigmaProp]`. The
 * bound is the integer k (SInt) and the input is the collection of sigma
 * propositions. Two Expr operands follow the opcode byte.
 *
 * Sigma-rust's `Atleast::new` (`mir/atleast.rs:27-46`) cross-checks
 * `bound.post_eval_tpe == SInt` and `input.post_eval_tpe ==
 * SColl(SSigmaProp)`. We do NOT enforce those at the wire layer — the wire
 * layer accepts what the bytes encode; type-shape checks live in a later
 * pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/atleast.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:170
 */

import type { Atleast, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `Atleast` payload (the OP_ATLEAST opcode byte was consumed by
 * the dispatcher). Reads two Expr nodes back-to-back: the bound (k) and
 * the input collection.
 *
 * Mirrors sigma-rust's `Atleast::sigma_parse`.
 */
export function parseAtleast(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Atleast {
  const bound = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'Atleast', bound, input }
}

/**
 * Serialize an `Atleast` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_ATLEAST opcode byte). Writes the bound then the input.
 */
export function serializeAtleast(a: Atleast, w: ByteWriter): void {
  serializeExpr(a.bound, w)
  serializeExpr(a.input, w)
}
