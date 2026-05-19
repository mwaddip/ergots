/**
 * Collection — parse + serialize.
 *
 * Sigma-rust models collection literals as a single `mir/collection.rs::Collection`
 * enum with two arms, each carrying its own opcode:
 *
 *   - `Exprs`         → `OP_COLL = 0x83`           (general collection of expressions)
 *   - `BoolConstants` → `OP_COLL_OF_BOOL_CONST = 0x85` (packed booleans optimisation)
 *
 * The type-level discriminator in this package is `kind: 'Exprs' | 'BoolConstants'`
 * on the shared `Collection` variant (`mir/types.ts:257-259`). On the wire the
 * dispatcher chooses the opcode based on `kind`; this module emits only the
 * payload bytes that follow the opcode.
 *
 * Exprs wire format (`mir/collection.rs::coll_sigma_serialize` arm 2,
 * `mir/collection.rs::coll_sigma_parse`):
 *
 *   [OP_COLL]
 *   [items_count: u16]            -- VLQ-encoded (Scorex `put_u16` is VLQ on top of u64)
 *   [elem_tpe: SType]             -- element type encoded via `serializeSType`
 *   [item_0: Expr] ... [item_n-1: Expr]
 *
 * Note: in sigma-rust `coll_sigma_parse` ALWAYS returns `Collection::Exprs`,
 * even when the SType says `SBoolean`. The optimisation lives on the write
 * side — `coll_sigma_serialize` peeks `kind` (which on construction is
 * upgraded to `BoolConstants` only when every item is `Const(SBoolean, ...)`)
 * and emits one opcode or the other. We mirror that asymmetry.
 *
 * BoolConstants wire format (`mir/collection.rs::coll_sigma_serialize` arm 1,
 * `mir/collection.rs::bool_const_coll_sigma_parse`):
 *
 *   [OP_COLL_OF_BOOL_CONST]
 *   [items_count: u16]            -- VLQ-encoded
 *   [packed_bits: ceil(n/8) bytes] -- LSB-first bit packing, matching
 *                                     `BitVec<u8, Lsb0>` (same as BinOp's
 *                                     bool-pair optimisation).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/collection.rs
 *   ~/projects/sigma-rust/sigma-rust/sigma-ser/src/vlq_encode.rs (put_bits / get_bits)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs
 *     (OpCode::COLL, OpCode::COLL_OF_BOOL_CONST dispatch)
 */

import type { Collection, Expr, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'

const MAX_COLL_ITEMS = 0xffff

/**
 * Parse a general `Collection::Exprs` payload (the OP_COLL opcode byte was
 * consumed by the dispatcher). Wire layout: VLQ-u16 count, SType element
 * type, then `count` Exprs back-to-back.
 *
 * Mirrors sigma-rust's `coll_sigma_parse` (`mir/collection.rs:99-110`). Note
 * sigma-rust always returns the `Exprs` arm here — the bool-packed shape
 * arrives via `OP_COLL_OF_BOOL_CONST` and {@link parseCollectionOfBoolConst}.
 */
export function parseCollection(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Collection {
  const count = r.readVlqU()
  const elemTpe = parseSType(r)
  const items: Expr[] = []
  for (let i = 0; i < count; i++) {
    items.push(parseExpr(r, constantTypes, constantValues, valDefTypes))
  }
  return { tag: 'Collection', kind: 'Exprs', elemTpe, items }
}

/**
 * Parse a `Collection::BoolConstants` payload (the OP_COLL_OF_BOOL_CONST
 * opcode byte was consumed by the dispatcher). Wire layout: VLQ-u16 count,
 * then `ceil(count/8)` packed bytes, LSB-first.
 *
 * Mirrors sigma-rust's `bool_const_coll_sigma_parse`
 * (`mir/collection.rs:112-117`) and the `get_bits` decoder
 * (`sigma-ser/src/vlq_encode.rs::get_bits`).
 */
export function parseCollectionOfBoolConst(r: ByteReader): Collection {
  const count = r.readVlqU()
  const byteCount = (count + 7) >> 3
  const packed = r.readBytes(byteCount)
  const items: boolean[] = []
  for (let i = 0; i < count; i++) {
    const byte = packed[i >> 3] ?? 0
    items.push(((byte >> (i & 7)) & 1) !== 0)
  }
  return { tag: 'Collection', kind: 'BoolConstants', items }
}

/**
 * Serialize a `Collection` payload (the dispatcher in {@link serializeExpr}
 * emits OP_COLL or OP_COLL_OF_BOOL_CONST based on `c.kind` before calling
 * this). The two payload shapes are emitted by the helpers below.
 *
 * Mirrors sigma-rust's `coll_sigma_serialize` (`mir/collection.rs:88-99`).
 */
export function serializeCollection(c: Collection, w: ByteWriter): void {
  if (c.kind === 'Exprs') {
    if (c.items.length > MAX_COLL_ITEMS) {
      throw new ExprSerializeError(
        `Collection.Exprs item count ${c.items.length} exceeds u16 max ${MAX_COLL_ITEMS}`,
        'collection-size-out-of-range'
      )
    }
    w.writeVlqU(c.items.length)
    serializeSType(c.elemTpe, w)
    for (const item of c.items) {
      serializeExpr(item, w)
    }
    return
  }
  // kind === 'BoolConstants'
  if (c.items.length > MAX_COLL_ITEMS) {
    throw new ExprSerializeError(
      `Collection.BoolConstants item count ${c.items.length} exceeds u16 max ${MAX_COLL_ITEMS}`,
      'collection-size-out-of-range'
    )
  }
  w.writeVlqU(c.items.length)
  // LSB-first bit packing. Matches `BitVec<u8, Lsb0>::from_vec`'s domain
  // iteration in `put_bits` (`sigma-ser/src/vlq_encode.rs`).
  const byteCount = (c.items.length + 7) >> 3
  const packed = new Uint8Array(byteCount)
  for (let i = 0; i < c.items.length; i++) {
    if (c.items[i]) {
      packed[i >> 3]! |= 1 << (i & 7)
    }
  }
  w.writeBytes(packed)
}
