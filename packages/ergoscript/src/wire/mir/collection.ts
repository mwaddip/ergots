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
 * on the shared `Collection` variant (`mir/types.ts`). The parsers read the payload
 * after the opcode the dispatcher consumed; `serializeCollection` writes the opcode
 * too, since it follows the JVM's `companion` rather than `kind` (see below).
 *
 * Exprs wire format (`mir/collection.rs::coll_sigma_serialize` arm 2,
 * `mir/collection.rs::coll_sigma_parse`):
 *
 *   [OP_COLL]
 *   [items_count: u16]            -- VLQ-encoded (Scorex `put_u16` is VLQ on top of u64)
 *   [elem_tpe: SType]             -- element type encoded via `serializeSType`
 *   [item_0: Expr] ... [item_n-1: Expr]
 *
 * Note: the parse returns `Exprs` for OP_COLL even when the SType says
 * `SBoolean`, as sigma-rust's `coll_sigma_parse` does. The write follows the
 * JVM, whose `ConcreteCollection.companion` writes an SBoolean collection of
 * constants as OP_COLL_OF_BOOL_CONST whichever opcode it was read with
 * (sigma/ast/values.scala:871-875). sigma-rust upgrades to `BoolConstants`
 * only in `Collection::new`, not at parse, so it writes such a parsed
 * collection back as OP_COLL: ergots follows the JVM.
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
import { OP_COLL, OP_COLL_OF_BOOL_CONST } from '../../mir/opcodes'
import { exprTpe } from '../../mir/expr-tpe'
import { jvmTypeEquals } from '../../mir/jvm-types'
import { ExprParseError, ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
import { readUShortCount } from './_jvm-counts'

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
  valDefTypes: Map<number, SType>,
  treeVersion: number
): Collection {
  // JVM ConcreteCollectionSerializer.scala:28: getUShort, which throws before getType (:29).
  const count = readUShortCount(r, 'Collection items count', 'collection-size-out-of-range')
  const elemTpe = parseSType(r)
  const items: Expr[] = []
  for (let i = 0; i < count; i++) {
    const item = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
    items.push(item)
    // ConcreteCollectionSerializer.scala:38: assert(v.tpe == tItem) after each item, before the next: an
    // AssertionError, which no sized tree degrades on. ergots' own SAny compares as unknown and passes
    // (jvmTypeEquals, residual 1).
    const itemTpe = exprTpe(item, treeVersion)
    if (jvmTypeEquals(itemTpe, elemTpe) === false) {
      throw new ExprParseError(
        `collection item ${i} has type ${itemTpe.tag}, not ${elemTpe.tag}`,
        'collection-item-type-mismatch'
      )
    }
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
  // JVM ConcreteCollectionBooleanConstantSerializer.scala:34: getUShort, then getBits (:35).
  const count = readUShortCount(r, 'Collection.BoolConstants count', 'collection-size-out-of-range')
  const byteCount = (count + 7) >>> 3
  const packed = r.readBytes(byteCount)
  const items: boolean[] = []
  for (let i = 0; i < count; i++) {
    const byte = packed[i >> 3] ?? 0
    items.push(((byte >> (i & 7)) & 1) !== 0)
  }
  return { tag: 'Collection', kind: 'BoolConstants', items }
}

/**
 * Serialize a `Collection`, opcode included, as the JVM writes it: the node's `companion` picks the
 * serializer (`ConcreteCollection.companion`, sigma/ast/values.scala:871-875). A collection whose
 * element type is SBoolean and whose items are all constants is a Boolean-constant collection,
 * written as OP_COLL_OF_BOOL_CONST with packed bits (`ConcreteCollectionBooleanConstantSerializer`),
 * whichever opcode it was read with, empty included; any other `Exprs` collection is OP_COLL
 * (`ConcreteCollectionSerializer`). A placeholder is not a constant, so a collection holding one
 * stays OP_COLL.
 *
 * sigma-rust's parse returns an `Exprs` collection for OP_COLL whatever its items, and writes it
 * back as OP_COLL: ergots follows the JVM here.
 */
export function serializeCollection(c: Collection, w: ByteWriter, treeVersion: number): void {
  if (c.kind === 'BoolConstants') {
    w.writeU8(OP_COLL_OF_BOOL_CONST)
    writeBoolConstants(c.items, w)
    return
  }
  // isBooleanConstants: elementType == SBoolean && items.forall(_.isInstanceOf[Constant[_]]) (:871).
  if (c.elemTpe.tag === 'SBoolean' && c.items.every((item) => item.tag === 'Const')) {
    w.writeU8(OP_COLL_OF_BOOL_CONST)
    writeBoolConstants(c.items.map(booleanConstantValue), w)
    return
  }
  if (c.items.length > MAX_COLL_ITEMS) {
    throw new ExprSerializeError(
      `Collection.Exprs item count ${c.items.length} exceeds u16 max ${MAX_COLL_ITEMS}`,
      'collection-size-out-of-range'
    )
  }
  w.writeU8(OP_COLL)
  w.writeVlqU(c.items.length)
  serializeSType(c.elemTpe, w)
  for (const item of c.items) {
    serializeExpr(item, w, treeVersion)
  }
}

/**
 * An item of a Boolean-constant collection. The JVM's serializer takes each item's value only from
 * a BooleanConstant and fails on any other (ConcreteCollectionBooleanConstantSerializer.scala:22-27):
 * a constant of another type, which the JVM's parse rejects before it gets here (the item-type
 * assert, ConcreteCollectionSerializer.scala:38), as `parseCollection` does. Only a collection built
 * through the API reaches this throw.
 */
function booleanConstantValue(item: Expr): boolean {
  if (item.tag === 'Const' && item.tpe.tag === 'SBoolean' && item.value.kind === 'Boolean') {
    return item.value.value
  }
  throw new ExprSerializeError(
    `a Coll[Boolean] of constants holds a ${item.tag === 'Const' ? item.tpe.tag : item.tag} item, not a Boolean constant`,
    'collection-item-not-boolean-constant'
  )
}

/**
 * The Boolean-constant payload: the count (putUShort), then the items packed LSB-first
 * (`putBits`; the same packing as `BitVec<u8, Lsb0>` in sigma-rust's `put_bits`).
 */
function writeBoolConstants(items: readonly boolean[], w: ByteWriter): void {
  if (items.length > MAX_COLL_ITEMS) {
    throw new ExprSerializeError(
      `Collection.BoolConstants item count ${items.length} exceeds u16 max ${MAX_COLL_ITEMS}`,
      'collection-size-out-of-range'
    )
  }
  w.writeVlqU(items.length)
  const packed = new Uint8Array((items.length + 7) >> 3)
  for (let i = 0; i < items.length; i++) {
    if (items[i]) {
      packed[i >> 3]! |= 1 << (i & 7)
    }
  }
  w.writeBytes(packed)
}
