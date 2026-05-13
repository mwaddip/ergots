import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 13 tests: BinOp round-trips for arithmetic, comparison, bitwise, and
 * logical sub-opcodes. ~22 wire opcodes collapse onto a single
 * `Expr.tag === 'BinOp'` AST node via the `BinOpKind` discriminator; the
 * tests cover one fixture per sub-kind plus the bool-pair packing
 * optimization which is unique to this variant.
 *
 * Wire format reminder (verified against sigma-rust source):
 *   - `BinOp` opcode encodes BOTH the AST variant AND the BinOpKind. After
 *     the opcode, the parser PEEKS the next byte:
 *       * if `OP_COLL_OF_BOOL_CONST` (0x85) → 2-bit-packed bool pair (LSB
 *         first), used when both operands are `Const(SBoolean)`.
 *       * else → that byte is the first byte of the left operand Expr,
 *         right operand follows.
 *   - Mirrors `serialization/bin_op.rs::bin_op_sigma_parse` and
 *     `bin_op_sigma_serialize`.
 *
 * The non-bool tests below use `Const(SInt N)` operands, which serialize as
 * `[0x04 (SInt opcode)][ZigZag-VLQ N]`. The bool-pair tests use the packed
 * shape verified by sigma-rust's `regression_249` fixture
 * (`true && true` → `[0xed, 0x85, 0x03]`).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/bin_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/bin_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs
 */

// Helper for hand-crafted byte arrays: `[header][BinOp opcode][left Const][right Const]`.
// Left/right are inline SInt constants with ZigZag-VLQ payloads.
function intBinOpBytes(
  opcode: number,
  leftZz: number,
  rightZz: number
): Uint8Array {
  return new Uint8Array([
    0x00, // header (v0, no size, no segregation)
    opcode,
    0x04, leftZz, // left = Const(SInt, ZigZag(N))
    0x04, rightZz, // right = Const(SInt, ZigZag(M))
  ])
}

describe('BinOp arithmetic', () => {
  it('round-trips Plus(SInt 1, SInt 2)', () => {
    // OP_PLUS = 0x9a, ZigZag(1) = 2 = 0x02, ZigZag(2) = 4 = 0x04
    const bytes = intBinOpBytes(0x9a, 0x02, 0x04)

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('BinOp')
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Arith', op: 'Plus' })

    expect(tree.body.left.tag).toBe('Const')
    if (tree.body.left.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.left.value).toEqual({ kind: 'Int', value: 1 })

    expect(tree.body.right.tag).toBe('Const')
    if (tree.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.right.value).toEqual({ kind: 'Int', value: 2 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips Minus(SInt 5, SInt 3)', () => {
    // OP_MINUS = 0x99, ZigZag(5) = 10 = 0x0a, ZigZag(3) = 6 = 0x06
    const bytes = intBinOpBytes(0x99, 0x0a, 0x06)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Arith', op: 'Minus' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Multiply(SInt 7, SInt 8)', () => {
    // OP_MULTIPLY = 0x9c, ZigZag(7) = 14 = 0x0e, ZigZag(8) = 16 = 0x10
    const bytes = intBinOpBytes(0x9c, 0x0e, 0x10)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Arith', op: 'Multiply' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Divide(SInt 10, SInt 2)', () => {
    // OP_DIVISION = 0x9d, ZigZag(10) = 20 = 0x14, ZigZag(2) = 4 = 0x04
    const bytes = intBinOpBytes(0x9d, 0x14, 0x04)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Arith', op: 'Divide' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Modulo(SInt 7, SInt 3)', () => {
    // OP_MODULO = 0x9e, ZigZag(7) = 14 = 0x0e, ZigZag(3) = 6 = 0x06
    const bytes = intBinOpBytes(0x9e, 0x0e, 0x06)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Arith', op: 'Modulo' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Min(SInt 1, SInt 2)', () => {
    // OP_MIN = 0xa1
    const bytes = intBinOpBytes(0xa1, 0x02, 0x04)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Arith', op: 'Min' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Max(SInt 1, SInt 2)', () => {
    // OP_MAX = 0xa2
    const bytes = intBinOpBytes(0xa2, 0x02, 0x04)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Arith', op: 'Max' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('BinOp relational', () => {
  it('round-trips Eq(SInt 1, SInt 1)', () => {
    // OP_EQ = 0x93
    const bytes = intBinOpBytes(0x93, 0x02, 0x02)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Relation', op: 'Eq' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips NEq(SInt 1, SInt 2)', () => {
    // OP_NEQ = 0x94
    const bytes = intBinOpBytes(0x94, 0x02, 0x04)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Relation', op: 'NEq' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Lt(SInt 1, SInt 2)', () => {
    // OP_LT = 0x8f
    const bytes = intBinOpBytes(0x8f, 0x02, 0x04)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Relation', op: 'Lt' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Le(SInt 1, SInt 1)', () => {
    // OP_LE = 0x90
    const bytes = intBinOpBytes(0x90, 0x02, 0x02)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Relation', op: 'Le' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Gt(SInt 1, SInt 0)', () => {
    // OP_GT = 0x91, ZigZag(0) = 0 = 0x00
    const bytes = intBinOpBytes(0x91, 0x02, 0x00)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Relation', op: 'Gt' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Ge(SInt 1, SInt 1)', () => {
    // OP_GE = 0x92
    const bytes = intBinOpBytes(0x92, 0x02, 0x02)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Relation', op: 'Ge' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('BinOp bitwise', () => {
  it('round-trips BitOr(SInt 0xff, SInt 0x0f)', () => {
    // OP_BIT_OR = 0xf2
    // ZigZag(0xff = 255) = 510 = 0xfe 0x03
    // ZigZag(0x0f = 15) = 30 = 0x1e
    const bytes = new Uint8Array([
      0x00, 0xf2,
      0x04, 0xfe, 0x03,
      0x04, 0x1e,
    ])
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Bit', op: 'BitOr' })
    if (tree.body.left.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.left.value).toEqual({ kind: 'Int', value: 255 })
    if (tree.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.right.value).toEqual({ kind: 'Int', value: 15 })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips BitAnd(SInt 0xff, SInt 0x0f)', () => {
    // OP_BIT_AND = 0xf3
    const bytes = new Uint8Array([
      0x00, 0xf3,
      0x04, 0xfe, 0x03,
      0x04, 0x1e,
    ])
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Bit', op: 'BitAnd' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips BitXor(SInt 0xff, SInt 0x0f)', () => {
    // OP_BIT_XOR = 0xf5 (the *bitwise* XOR; distinct from OP_BIN_XOR = 0xf4
    // which is the *logical* XOR).
    const bytes = new Uint8Array([
      0x00, 0xf5,
      0x04, 0xfe, 0x03,
      0x04, 0x1e,
    ])
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Bit', op: 'BitXor' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips BitShiftLeft(SInt 1, SInt 4)', () => {
    // OP_BIT_SHIFT_LEFT = 0xf7. Added in sigma-rust PR 862.
    const bytes = intBinOpBytes(0xf7, 0x02, 0x08)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Bit', op: 'BitShiftLeft' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips BitShiftRight(SInt 16, SInt 2)', () => {
    // OP_BIT_SHIFT_RIGHT = 0xf6. ZigZag(16) = 32 = 0x20, ZigZag(2) = 4 = 0x04.
    const bytes = intBinOpBytes(0xf6, 0x20, 0x04)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Bit', op: 'BitShiftRight' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips BitShiftRightZeroed(SInt 16, SInt 2)', () => {
    // OP_BIT_SHIFT_RIGHT_ZEROED = 0xf8. The logical (zero-fill) `>>>` op.
    const bytes = intBinOpBytes(0xf8, 0x20, 0x04)
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Bit', op: 'BitShiftRightZeroed' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('BinOp logical (bool-pair packed shape)', () => {
  it('round-trips And(true, true) using OP_COLL_OF_BOOL_CONST shape', () => {
    // Matches sigma-rust's regression_249 fixture: `true && true` encodes
    // as `[OP_BIN_AND][OP_COLL_OF_BOOL_CONST][0x03]`.
    //   OP_BIN_AND = 0xed
    //   OP_COLL_OF_BOOL_CONST = 0x85
    //   packed = 0b11 = 0x03 (bit 0 = left = true, bit 1 = right = true)
    const bytes = new Uint8Array([0x00, 0xed, 0x85, 0x03])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Logical', op: 'And' })

    expect(tree.body.left.tag).toBe('Const')
    if (tree.body.left.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.left.tpe).toEqual({ tag: 'SBoolean' })
    expect(tree.body.left.value).toEqual({ kind: 'Boolean', value: true })

    expect(tree.body.right.tag).toBe('Const')
    if (tree.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.right.value).toEqual({ kind: 'Boolean', value: true })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips Or(false, true) using packed shape (bit pattern 0b10)', () => {
    // OP_BIN_OR = 0xec. left = false (bit 0 = 0), right = true (bit 1 = 1),
    // packed = 0b10 = 0x02.
    const bytes = new Uint8Array([0x00, 0xec, 0x85, 0x02])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Logical', op: 'Or' })
    if (tree.body.left.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.left.value).toEqual({ kind: 'Boolean', value: false })
    if (tree.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.right.value).toEqual({ kind: 'Boolean', value: true })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Xor(true, false) using packed shape (bit pattern 0b01)', () => {
    // OP_BIN_XOR = 0xf4 (logical XOR; distinct from OP_BIT_XOR = 0xf5).
    // left = true (bit 0 = 1), right = false (bit 1 = 0), packed = 0b01 = 0x01.
    const bytes = new Uint8Array([0x00, 0xf4, 0x85, 0x01])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Logical', op: 'Xor' })
    if (tree.body.left.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.left.value).toEqual({ kind: 'Boolean', value: true })
    if (tree.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.right.value).toEqual({ kind: 'Boolean', value: false })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('BinOp programmatic construction', () => {
  it('builds Plus(SLong 100, SLong 50) from scratch and round-trips', () => {
    // Programmatic AST build → serialize → re-parse. Confirms the
    // serializer correctly emits the BinOp opcode (derived from op.kind/op.op)
    // and that the round-trip preserves all fields.
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00,
      },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'BinOp',
        op: { kind: 'Arith', op: 'Plus' },
        left: {
          tag: 'Const',
          tpe: { tag: 'SLong' },
          value: { kind: 'Long', value: 100n },
        },
        right: {
          tag: 'Const',
          tpe: { tag: 'SLong' },
          value: { kind: 'Long', value: 50n },
        },
      },
    }
    const out = serializeTree(tree)
    // header + OP_PLUS (0x9a)
    //   + SLong code (0x05) + ZigZag(100) = 200 = 0xc8 0x01
    //   + SLong code (0x05) + ZigZag(50)  = 100 = 0x64
    expect(Array.from(out)).toEqual([
      0x00, 0x9a, 0x05, 0xc8, 0x01, 0x05, 0x64,
    ])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(reparsed.body.op).toEqual({ kind: 'Arith', op: 'Plus' })
    if (reparsed.body.left.tag !== 'Const') throw new Error('unreachable')
    expect(reparsed.body.left.value).toEqual({ kind: 'Long', value: 100n })
    if (reparsed.body.right.tag !== 'Const') throw new Error('unreachable')
    expect(reparsed.body.right.value).toEqual({ kind: 'Long', value: 50n })
  })

  it('builds And(true, false) and serializes as bool-pair packed', () => {
    // Confirms the serializer takes the bool-pair fast path when both operands
    // are Const(SBoolean). Expected output: `[OP_BIN_AND][OP_COLL_OF_BOOL_CONST][0x01]`
    // (left=true sets bit 0, right=false leaves bit 1 clear).
    const tree: ErgoTree = {
      header: {
        version: 0,
        hasSize: false,
        constantSegregation: false,
        rawHeader: 0x00,
      },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'BinOp',
        op: { kind: 'Logical', op: 'And' },
        left: {
          tag: 'Const',
          tpe: { tag: 'SBoolean' },
          value: { kind: 'Boolean', value: true },
        },
        right: {
          tag: 'Const',
          tpe: { tag: 'SBoolean' },
          value: { kind: 'Boolean', value: false },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0xed, 0x85, 0x01])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(reparsed.body.op).toEqual({ kind: 'Logical', op: 'And' })
  })

  it('nested BinOp: Plus(Plus(1, 2), 3) round-trips', () => {
    // Confirms recursive parse/serialize via the central Expr dispatcher.
    // Outer BinOp: Plus with left=BinOp, right=Const(SInt 3).
    // Inner BinOp: Plus(Const(SInt 1), Const(SInt 2)).
    //
    // bytes:
    //   0x00       header
    //   0x9a       OP_PLUS (outer)
    //   0x9a       OP_PLUS (inner) — first byte of left, peeked by outer
    //   0x04 0x02  inner left = Const(SInt 1)
    //   0x04 0x04  inner right = Const(SInt 2)
    //   0x04 0x06  outer right = Const(SInt 3)
    const bytes = new Uint8Array([
      0x00, 0x9a, 0x9a, 0x04, 0x02, 0x04, 0x04, 0x04, 0x06,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.op).toEqual({ kind: 'Arith', op: 'Plus' })
    expect(tree.body.left.tag).toBe('BinOp')
    if (tree.body.left.tag !== 'BinOp') throw new Error('unreachable')
    expect(tree.body.left.op).toEqual({ kind: 'Arith', op: 'Plus' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('BinOp negative paths', () => {
  it('rejects truncated bytes while parsing right operand', () => {
    // bytes:
    //   0x00       header
    //   0x9a       OP_PLUS
    //   0x04 0x02  left = Const(SInt 1)
    //   (right operand truncated — no bytes follow)
    //
    // Reader throws ReaderError(code='truncated'). Wrapped by the outer
    // envelope parse; we assert the underlying ReaderError surfaces as a
    // generic Error (it's not wrapped in ExprParseError today — see
    // wire/parse.ts `parseExpr` letting reader errors propagate).
    const bytes = new Uint8Array([0x00, 0x9a, 0x04, 0x02])
    // The reader will throw on the missing left-operand byte (0x04 ... missing payload).
    // The byte 0x04 = OP_COLL_OF_BOOL_CONST? No — 0x04 < LAST_CONSTANT_CODE so
    // dispatcher routes to parseConstFromByte which then tries to read more
    // payload (the ZigZag VLQ) and fails.
    //
    // Actually the right operand starts being read AFTER left's payload (0x02).
    // The byte sequence has [0x00 header, 0x9a OP_PLUS, 0x04 left-SType, 0x02 left-payload]
    // — and then parser tries to read the right operand opcode and hits EOF.
    let err: unknown
    try {
      parseTree(bytes)
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    // Either ReaderError(code='truncated') or wrapped — accept either.
    if (err instanceof Error) {
      // sanity check the cause is truncation-related
      expect(
        // ReaderError code is `truncated`
        (err as { code?: string }).code === 'truncated' ||
        err.message.includes('EOF') ||
        err.message.includes('truncated')
      ).toBe(true)
    }
  })
})
