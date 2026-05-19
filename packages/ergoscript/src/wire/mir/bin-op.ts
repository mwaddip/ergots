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
 * Bool-pair packing optimization (sigma-rust `bin_op_sigma_serialize`):
 * when BOTH operands are `Const(SBoolean, _)`, sigma-rust emits a single
 * `OP_COLL_OF_BOOL_CONST` byte followed by 1 packed byte with 2 LSB-first
 * bits (rather than two full `Const` encodings, which would be
 * `0x01 [b0] 0x01 [b1]` = 4 bytes). On parse, after consuming the BinOp
 * opcode the parser peeks the next byte — if it's `OP_COLL_OF_BOOL_CONST`
 * it takes the fast path; otherwise the peeked byte is the first byte of
 * the left operand and is fed back into the central Expr dispatch via
 * {@link parseExprWithFirstByte}. We mirror this exactly to preserve
 * byte-for-byte round-trip equivalence with sigma-rust output (the
 * `regression_249` test in `mir/bin_op.rs` confirms `true && true`
 * encodes as `[0xed, 0x85, 0x03]`).
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
// Forward import for recursive descent — see comment in val-def.ts. Plus
// `parseExprWithFirstByte` which is needed because the BinOp parser peeks
// the next byte to detect the bool-pair fast path and must feed it back
// into Expr dispatch when the fast path doesn't trigger.
import { parseExpr, parseExprWithFirstByte } from '../parse'
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
 * After the opcode, sigma-rust peeks the NEXT byte:
 *   - if it's `OP_COLL_OF_BOOL_CONST` (0x85), the two operands are encoded
 *     as a 2-bit packed `Const(SBoolean)` pair (LSB-first).
 *   - otherwise the bytes encode two normal `Expr` nodes back-to-back, with
 *     the peeked byte being the first byte of the left operand.
 *
 * Mirrors sigma-rust's `bin_op_sigma_parse` in
 * `serialization/bin_op.rs:47-123` (minus the v3-Upcast-reinsertion logic
 * gated on `tree_version() < V3` — that's a higher-layer semantic mapping
 * concern, not a wire-format concern, and our package does not yet model
 * tree versions per-parse).
 */
export function parseBinOpFromByte(
  opcode: number,
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
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

  // Peek the next byte (sigma-rust: `let tag = r.get_u8()?` then conditional
  // on COLL_OF_BOOL_CONST). We consume it unconditionally and either
  // (a) take the bool-pair fast path, or (b) treat it as the first byte of
  // the left operand and dispatch via parseExprWithFirstByte.
  const tag = r.readU8()
  if (tag === OP.OP_COLL_OF_BOOL_CONST) {
    // LSB-first bit packing: bit 0 = left, bit 1 = right. Mirrors
    // sigma-rust's `BitVec<u8, Lsb0>::from_vec` decode in `get_bits(2)`.
    const packed = r.readU8()
    const left: Expr = {
      tag: 'Const',
      tpe: { tag: 'SBoolean' },
      value: { kind: 'Boolean', value: (packed & 0x01) !== 0 },
    }
    const right: Expr = {
      tag: 'Const',
      tpe: { tag: 'SBoolean' },
      value: { kind: 'Boolean', value: (packed & 0x02) !== 0 },
    }
    return { tag: 'BinOp', op: kind, left, right }
  }

  // Not the bool-pair shape. The peeked byte is the first byte of the left
  // operand — route it through the central Expr dispatch via
  // parseExprWithFirstByte. Right operand follows as a normal Expr.
  const left = parseExprWithFirstByte(
    tag,
    r,
    constantTypes,
    constantValues,
    valDefTypes
  )
  const right = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'BinOp', op: kind, left, right }
}

/**
 * Serialize a `BinOp`. Emits the BinOpKind-derived opcode byte first, then
 * either:
 *   (a) the bool-pair packed shape if BOTH operands are `Const(SBoolean)`:
 *       `[opcode][OP_COLL_OF_BOOL_CONST][packed byte]`, or
 *   (b) the two operands as full Expr encodings:
 *       `[opcode][left Expr][right Expr]`.
 *
 * Mirrors sigma-rust's combined `op_code.sigma_serialize` +
 * `bin_op_sigma_serialize` flow at `serialization/expr.rs:269-272`. Unlike
 * sigma-rust we do NOT consult a constant store / placeholder shape on
 * either operand — our serializer doesn't model the constant-store-mutating
 * write path used by `SigmaByteWriter` with segregation enabled (see the
 * design spec's "no constant store on write" decision).
 */
export function serializeBinOp(b: BinOp, w: ByteWriter): void {
  const opcode = binOpKindToOpcode(b.op)
  w.writeU8(opcode)

  // Bool-pair packing: both operands are `Const(SBoolean, Boolean ...)`.
  // Mirrors sigma-rust's `bin_op_sigma_serialize` (`serialization/bin_op.rs:24-39`):
  // `match (*bin_op.clone().left, *bin_op.clone().right) { (Expr::Const(_:SBoolean), Expr::Const(_:SBoolean)) => ... }`.
  if (
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
  serializeExpr(b.left, w)
  serializeExpr(b.right, w)
}
