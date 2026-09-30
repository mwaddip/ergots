/**
 * BinOp — parse + serialize.
 *
 * Wire format (sigma-rust `serialization/bin_op.rs`,
 * `serialization/expr.rs:131-160,259-272`):
 *
 *   [BinOp opcode] [left Expr] [right Expr]
 *
 * The opcode byte BOTH identifies the variant as a BinOp AND selects the
 * specific {@link BinOpKind} (arithmetic / relational / logical / bitwise).
 * ~22 opcodes share a single `BinOp` AST variant, distinguished by the
 * sub-kind. The mapping is captured by {@link BIN_OP_OPCODE_TO_KIND} (parse)
 * and {@link binOpKindToOpcode} (serialize).
 *
 * Packed Boolean pair: only the JVM's nine Relation2 opcodes use it — GT, GE,
 * LT, LE, EQ, NEQ, BinOr, BinAnd, BinXor (`ValueSerializer.scala:48-58`,
 * `trees/Relation2Serializer.scala:21-52`), here the `Relation` and `Logical`
 * kinds. When BOTH operands are `Const(SBoolean, _)`, Relation2 writes
 * `OP_COLL_OF_BOOL_CONST` (0x85) and one byte carrying the two values as
 * LSB-first bits, instead of two full `Const` encodings (`0x01 [b0] 0x01 [b1]`);
 * `true && true` encodes as `[0xed, 0x85, 0x03]`. On parse, Relation2 peeks the
 * next byte with no window check: on 0x85 it consumes it and reads the packed
 * byte, otherwise it reads two full values. The `Arith` and `Bit` kinds use
 * `TwoArgumentsSerializer` (`TwoArgumentsSerializer.scala:15-25`): no packing
 * and no lookahead, so a 0x85 after one of their opcodes begins a
 * `Coll[Boolean]` operand. sigma-rust packs and peeks for every BinOp kind
 * (`bin_op_sigma_parse`); ergots follows the JVM, so do not align this with
 * sigma-rust.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/bin_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/bin_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:131-160,259-272
 */

import type {
  BinOp,
  BinOpKind,
  Expr,
  SType,
  SValue,
} from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprParseError, ExprSerializeError } from '../errors'
import * as OP from '../../mir/opcodes'
// Forward import for recursive descent — see comment in val-def.ts.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Map from opcode byte → BinOpKind. Mirrors sigma-rust's
 * `bin_op_sigma_parse` dispatch and the per-sub-enum `From<X> for OpCode`
 * impls in `mir/bin_op.rs:38-52, 87-96, 124-132, 158-167`.
 *
 * Exported so adjacent modules / tests can introspect the mapping. The
 * inverse direction is computed by {@link binOpKindToOpcode}; using a
 * function rather than a lookup table avoids needing a `BinOpKind`-keyed
 * Map (the discriminated union isn't a primitive key).
 */
export const BIN_OP_OPCODE_TO_KIND: Record<number, BinOpKind> = {
  // Arithmetic
  [OP.OP_PLUS]: { kind: 'Arith', op: 'Plus' },
  [OP.OP_MINUS]: { kind: 'Arith', op: 'Minus' },
  [OP.OP_MULTIPLY]: { kind: 'Arith', op: 'Multiply' },
  [OP.OP_DIVISION]: { kind: 'Arith', op: 'Divide' },
  [OP.OP_MODULO]: { kind: 'Arith', op: 'Modulo' },
  [OP.OP_MIN]: { kind: 'Arith', op: 'Min' },
  [OP.OP_MAX]: { kind: 'Arith', op: 'Max' },
  // Relational
  [OP.OP_EQ]: { kind: 'Relation', op: 'Eq' },
  [OP.OP_NEQ]: { kind: 'Relation', op: 'NEq' },
  [OP.OP_LT]: { kind: 'Relation', op: 'Lt' },
  [OP.OP_LE]: { kind: 'Relation', op: 'Le' },
  [OP.OP_GT]: { kind: 'Relation', op: 'Gt' },
  [OP.OP_GE]: { kind: 'Relation', op: 'Ge' },
  // Logical (binary)
  [OP.OP_BIN_AND]: { kind: 'Logical', op: 'And' },
  [OP.OP_BIN_OR]: { kind: 'Logical', op: 'Or' },
  [OP.OP_BIN_XOR]: { kind: 'Logical', op: 'Xor' },
  // Bitwise
  [OP.OP_BIT_OR]: { kind: 'Bit', op: 'BitOr' },
  [OP.OP_BIT_AND]: { kind: 'Bit', op: 'BitAnd' },
  [OP.OP_BIT_XOR]: { kind: 'Bit', op: 'BitXor' },
  [OP.OP_BIT_SHIFT_LEFT]: { kind: 'Bit', op: 'BitShiftLeft' },
  [OP.OP_BIT_SHIFT_RIGHT]: { kind: 'Bit', op: 'BitShiftRight' },
  [OP.OP_BIT_SHIFT_RIGHT_ZEROED]: { kind: 'Bit', op: 'BitShiftRightZeroed' },
}

/**
 * Inverse mapping: BinOpKind → opcode byte. Computed via direct
 * pattern-match on the kind discriminator. Mirrors sigma-rust's
 * `impl From<BinOpKind> for OpCode` chain (`mir/bin_op.rs:199-208`).
 */
export function binOpKindToOpcode(k: BinOpKind): number {
  switch (k.kind) {
    case 'Arith':
      switch (k.op) {
        case 'Plus': return OP.OP_PLUS
        case 'Minus': return OP.OP_MINUS
        case 'Multiply': return OP.OP_MULTIPLY
        case 'Divide': return OP.OP_DIVISION
        case 'Modulo': return OP.OP_MODULO
        case 'Min': return OP.OP_MIN
        case 'Max': return OP.OP_MAX
      }
      // Fall through to the throw below if a future ArithOp lacks a case.
      break
    case 'Relation':
      switch (k.op) {
        case 'Eq': return OP.OP_EQ
        case 'NEq': return OP.OP_NEQ
        case 'Lt': return OP.OP_LT
        case 'Le': return OP.OP_LE
        case 'Gt': return OP.OP_GT
        case 'Ge': return OP.OP_GE
      }
      break
    case 'Logical':
      switch (k.op) {
        case 'And': return OP.OP_BIN_AND
        case 'Or': return OP.OP_BIN_OR
        case 'Xor': return OP.OP_BIN_XOR
      }
      break
    case 'Bit':
      switch (k.op) {
        case 'BitOr': return OP.OP_BIT_OR
        case 'BitAnd': return OP.OP_BIT_AND
        case 'BitXor': return OP.OP_BIT_XOR
        case 'BitShiftLeft': return OP.OP_BIT_SHIFT_LEFT
        case 'BitShiftRight': return OP.OP_BIT_SHIFT_RIGHT
        case 'BitShiftRightZeroed': return OP.OP_BIT_SHIFT_RIGHT_ZEROED
      }
      break
  }
  throw new ExprSerializeError(
    `Unhandled BinOpKind: ${JSON.stringify(k)}`,
    'unknown-binop-kind'
  )
}

/**
 * Parse a `BinOp` payload. The BinOp opcode byte has already been consumed
 * by the dispatcher and is passed in as `opcode` — it carries the kind
 * discriminator.
 *
 * The operands are read as the serializer the JVM registers for the opcode
 * reads them (`ValueSerializer.scala:48-75`):
 *   - Relation2 (the `Relation` and `Logical` kinds,
 *     `trees/Relation2Serializer.scala:40-52`) peeks the next byte with no
 *     window check. On `OP_COLL_OF_BOOL_CONST` (0x85) it consumes that byte
 *     and reads one packed byte: two `Const(SBoolean)` operands, bit 0 the
 *     left, bit 1 the right. Otherwise it reads two full values.
 *   - TwoArguments (the `Arith` and `Bit` kinds,
 *     `TwoArgumentsSerializer.scala:21-25`) reads two full values, with no
 *     lookahead.
 *
 * For a pre-v3 tree the JVM's deserialization builder also inserts `Upcast`
 * nodes when the two operands have different numeric types (`applyUpcast`,
 * `SigmaBuilder.scala:674-683`, applied by the deserialization builder only
 * below v3, `:750-764`). The parse does not; the evaluator coerces such
 * operands instead (`eval/bin-op/arith.ts`, `eval/bin-op/relation.ts`), and the
 * re-encoding does not write the inserted nodes (residual 11). For a relation,
 * the parse hook records which operand the builder wrapped
 * (`recordRelationUpcast`, `wire/check-build.ts`), so that a substitution
 * rebuild re-checks it as Kiama's `dup` re-checks the `Upcast`.
 */
export function parseBinOpFromByte(
  opcode: number,
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): BinOp {
  const kind = BIN_OP_OPCODE_TO_KIND[opcode]
  if (!kind) {
    // Defensive: the dispatcher only routes here for opcodes in the map.
    // A future caller mis-dispatching would otherwise produce a confusing
    // "kind is undefined" error downstream.
    throw new ExprParseError(
      `parseBinOpFromByte: opcode 0x${opcode.toString(16).padStart(2, '0')} is not a BinOp opcode`,
      'invalid-binop-opcode'
    )
  }

  // Relation2Serializer (trees/Relation2Serializer.scala:40-52) serves only GT, GE, LT, LE, EQ, NEQ,
  // BinOr, BinAnd, BinXor (ValueSerializer.scala:48-58): peek (no window check); on 0x85 skip it
  // (getByte) and read a packed pair (getBits(2), one checked byte); else two full values.
  if ((kind.kind === 'Relation' || kind.kind === 'Logical') && r.peekU8() === OP.OP_COLL_OF_BOOL_CONST) {
    r.readU8()
    const packed = r.readU8()
    const left: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: (packed & 0x01) !== 0 } }
    const right: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: (packed & 0x02) !== 0 } }
    return { tag: 'BinOp', op: kind, left, right }
  }
  // TwoArgumentsSerializer (TwoArgumentsSerializer.scala:21-25), and Relation2's general case.
  const left = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const right = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'BinOp', op: kind, left, right }
}

/**
 * Serialize a `BinOp`. Emits the BinOpKind-derived opcode byte first, then
 * either:
 *   (a) for the `Relation` and `Logical` kinds (the JVM's Relation2) when BOTH
 *       operands are `Const(SBoolean)`, the packed pair:
 *       `[opcode][OP_COLL_OF_BOOL_CONST][packed byte]`, or
 *   (b) the two operands as full Expr encodings:
 *       `[opcode][left Expr][right Expr]`.
 *
 * We do NOT consult a constant store / placeholder shape on
 * either operand — our serializer doesn't model the constant-store-mutating
 * write path used by `SigmaByteWriter` with segregation enabled (see the
 * design spec's "no constant store on write" decision).
 */
export function serializeBinOp(b: BinOp, w: ByteWriter, treeVersion: number): void {
  const opcode = binOpKindToOpcode(b.op)
  w.writeU8(opcode)

  // Packed Boolean pair, for Relation2's opcodes only (the `Relation` and `Logical` kinds):
  // JVM Relation2Serializer.serialize (trees/Relation2Serializer.scala:21-37) packs when both
  // operands are `Constant`s of type SBoolean. TwoArgumentsSerializer.serialize
  // (TwoArgumentsSerializer.scala:15-19) always writes two full values.
  if (
    (b.op.kind === 'Relation' || b.op.kind === 'Logical') &&
    b.left.tag === 'Const' &&
    b.left.tpe.tag === 'SBoolean' &&
    b.left.value.kind === 'Boolean' &&
    b.right.tag === 'Const' &&
    b.right.tpe.tag === 'SBoolean' &&
    b.right.value.kind === 'Boolean'
  ) {
    w.writeU8(OP.OP_COLL_OF_BOOL_CONST)
    // LSB-first bit pack: bit 0 = left, bit 1 = right. Matches
    // `WriteSigmaVlqExt::put_bits` with `BitVec<u8, Lsb0>`.
    const packed =
      (b.left.value.value ? 1 : 0) |
      (b.right.value.value ? 2 : 0)
    w.writeU8(packed)
    return
  }

  // General case: serialize both operands as normal Exprs.
  serializeExpr(b.left, w, treeVersion)
  serializeExpr(b.right, w, treeVersion)
}
