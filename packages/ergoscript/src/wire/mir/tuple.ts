/**
 * Tuple — parse + serialize.
 *
 * Wire format (sigma-rust `mir/tuple.rs:48-65`):
 *
 *   [OP_TUPLE opcode = 0x86]
 *   [items_count: u8]           -- bounded 2..=255 by `TupleItems<T>` in
 *                                  sigma-rust (`types/stuple.rs:14`)
 *   [item_0: Expr]
 *   ...
 *   [item_n-1: Expr]
 *
 * Length-prefix is a raw u8 (NOT VLQ): sigma-rust uses `w.put_u8(len as u8)`
 * and `r.get_u8()`, matching the bound that the count fits in one byte.
 *
 * Tuple's bounds (2..=255 items) are enforced both by sigma-rust's
 * `TupleItems<T>` newtype on construction and at parse time (`try_into()` at
 * `mir/tuple.rs:60-63` propagates `BoundedVecOutOfBounds` as a parse error).
 * We mirror both bounds at the wire layer.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/tuple.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/stuple.rs:14
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (OpCode::TUPLE)
 */

import type { Tuple, SType, SValue, Expr } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprParseError, ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

const MIN_TUPLE_ITEMS = 2
const MAX_TUPLE_ITEMS = 255

/**
 * Parse a `Tuple` payload (the OP_TUPLE opcode byte was consumed by the
 * dispatcher). Reads a one-byte item count and then that many Exprs.
 *
 * Mirrors sigma-rust's `<Tuple as SigmaSerializable>::sigma_parse`
 * (`mir/tuple.rs:55-65`) and the bounded `TupleItems` newtype.
 */
export function parseTuple(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Tuple {
  const count = r.readU8()
  if (count < MIN_TUPLE_ITEMS) {
    throw new ExprParseError(
      `Tuple item count ${count} below minimum ${MIN_TUPLE_ITEMS}`,
      'tuple-arity-out-of-range'
    )
  }
  const items: Expr[] = []
  for (let i = 0; i < count; i++) {
    items.push(parseExpr(r, constantTypes, constantValues, valDefTypes))
  }
  return { tag: 'Tuple', items }
}

/**
 * Serialize a `Tuple` payload (the dispatcher in {@link serializeExpr} emits
 * the OP_TUPLE opcode byte). Writes the one-byte item count then each item
 * as a full Expr.
 */
export function serializeTuple(t: Tuple, w: ByteWriter): void {
  const n = t.items.length
  if (n < MIN_TUPLE_ITEMS || n > MAX_TUPLE_ITEMS) {
    throw new ExprSerializeError(
      `Tuple item count ${n} out of range [${MIN_TUPLE_ITEMS}, ${MAX_TUPLE_ITEMS}]`,
      'tuple-arity-out-of-range'
    )
  }
  w.writeU8(n)
  for (const item of t.items) {
    serializeExpr(item, w)
  }
}
