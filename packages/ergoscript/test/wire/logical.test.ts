import { describe, it, expect } from 'vitest'
import { serializeTree } from '../../src/wire/ergo-tree'
import { parseParsedTree as parseTree } from '../_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 14 tests: round-trips for UnaryOp-family (`Negation`, `LogicalNot`,
 * `BitInversion`), `And`, `Or`, `Xor`, `XorOf`, `Atleast`, and
 * `BoolToSigmaProp`. Drives the parsers end-to-end via the `parseTree` /
 * `serializeTree` envelope so per-variant code runs in its real call context.
 *
 * Wire format reminders (verified against sigma-rust source):
 *   - `Negation` (opcode 0xf0), `LogicalNot` (0xef), `BitInversion` (0xf1):
 *     `[opcode] [input Expr]`. Sigma-rust uses the `OneArgOp` blanket impl
 *     in `mir/unary_op.rs:26-36`.
 *   - `And` (0x96), `Or` (0x97), `XorOf` (0xff): `[opcode] [input Expr]`
 *     where input is `Coll[SBoolean]` semantically. Mirrors `mir/and.rs`,
 *     `mir/or.rs`, `mir/xor_of.rs`.
 *   - `Xor` (0x9b): `[opcode] [left Expr] [right Expr]` where both are
 *     `Coll[SByte]` semantically. Mirrors `mir/xor.rs`.
 *   - `Atleast` (0x98): `[opcode] [bound Expr] [input Expr]`. Mirrors
 *     `mir/atleast.rs`.
 *   - `BoolToSigmaProp` (0xd1): `[opcode] [input Expr]`. Mirrors
 *     `mir/bool_to_sigma.rs`.
 *
 * Type-shape checks (`Coll[SBoolean]`, numeric input, etc.) are NOT enforced
 * at the wire layer — sigma-rust's `try_build` constructors do them, but the
 * wire-layer parser is permissive. We mirror that.
 *
 * Coll[SBoolean] encoding reminder (used by And/Or/XorOf/Atleast tests):
 *   - SType code: 12 + 1 (SBoolean primId) = 13 = 0x0d
 *   - Length: VLQ-u32
 *   - Items: LSB-first bit-packed, ceil(n/8) bytes.
 *
 * Coll[SByte] encoding reminder (used by Xor test):
 *   - SType code: 12 + 2 (SByte primId) = 14 = 0x0e
 *   - Length: VLQ-u32
 *   - Items: raw bytes (NativeColl optimization, no per-item VLQ).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/{and,or,xor,xor_of,atleast,bool_to_sigma,logical_not,negation,bit_inversion}.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:133-201
 */

describe('Negation variant', () => {
  it('round-trips Negation(Const SInt 1)', () => {
    // AST: -1
    //
    // bytes:
    //   0x00       header (v0, no size, no segregation)
    //   0xf0       OP_NEGATION
    //   0x04 0x02  input = Const(SInt, ZigZag(1)=2)
    const bytes = new Uint8Array([0x00, 0xf0, 0x04, 0x02])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Negation')
    if (tree.body.tag !== 'Negation') throw new Error('unreachable')
    expect(tree.body.input.tag).toBe('Const')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SInt' })
    expect(tree.body.input.value).toEqual({ kind: 'Int', value: 1 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips Negation(Const SLong)', () => {
    // AST: -(10L)  --  ZigZag(10) = 20 = 0x14
    const bytes = new Uint8Array([0x00, 0xf0, 0x05, 0x14])
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Negation') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SLong' })
    expect(tree.body.input.value).toEqual({ kind: 'Long', value: 10n })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes Negation programmatically', () => {
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
        tag: 'Negation',
        input: {
          tag: 'Const',
          tpe: { tag: 'SInt' },
          value: { kind: 'Int', value: 5 },
        },
      },
    }
    const out = serializeTree(tree)
    // header + OP_NEGATION + SInt(0x04) + ZigZag(5)=10=0x0a
    expect(Array.from(out)).toEqual([0x00, 0xf0, 0x04, 0x0a])
  })
})

describe('LogicalNot variant', () => {
  it('round-trips LogicalNot(Const SBoolean true)', () => {
    // AST: !true
    //
    // bytes:
    //   0x00       header
    //   0xef       OP_LOGICAL_NOT
    //   0x01 0x01  input = Const(SBoolean true)
    const bytes = new Uint8Array([0x00, 0xef, 0x01, 0x01])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('LogicalNot')
    if (tree.body.tag !== 'LogicalNot') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value).toEqual({ kind: 'Boolean', value: true })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips nested LogicalNot(LogicalNot(true))', () => {
    // AST: !!true  -- confirms recursive descent through the dispatcher.
    const bytes = new Uint8Array([0x00, 0xef, 0xef, 0x01, 0x01])
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'LogicalNot') throw new Error('unreachable')
    expect(tree.body.input.tag).toBe('LogicalNot')
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('BitInversion variant', () => {
  it('round-trips BitInversion(Const SInt 0)', () => {
    // AST: ~0  --  ZigZag(0) = 0
    const bytes = new Uint8Array([0x00, 0xf1, 0x04, 0x00])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('BitInversion')
    if (tree.body.tag !== 'BitInversion') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SInt' })
    expect(tree.body.input.value).toEqual({ kind: 'Int', value: 0 })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips BitInversion(Const SLong 1)', () => {
    // AST: ~1L  --  ZigZag(1) = 2
    const bytes = new Uint8Array([0x00, 0xf1, 0x05, 0x02])
    const tree = parseTree(bytes)
    if (tree.body.tag !== 'BitInversion') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SLong' })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('And variant', () => {
  it('round-trips And(Const Coll[SBoolean] [true, false, true])', () => {
    // AST: anyOf-style — `And(Coll(true, false, true))`.
    //
    // bytes:
    //   0x00       header
    //   0x96       OP_AND
    //   0x0d       SType code for Coll[SBoolean] = 12 + 1
    //   0x03       count VLQ = 3
    //   0x05       bit-packed (LSB first): bit0=1, bit1=0, bit2=1 = 0b101 = 0x05
    const bytes = new Uint8Array([0x00, 0x96, 0x0d, 0x03, 0x05])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('And')
    if (tree.body.tag !== 'And') throw new Error('unreachable')
    expect(tree.body.input.tag).toBe('Const')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({
      tag: 'SColl',
      elem: { tag: 'SBoolean' },
    })
    expect(tree.body.input.value).toEqual({
      kind: 'Coll',
      elem: { tag: 'SBoolean' },
      items: [
        { kind: 'Boolean', value: true },
        { kind: 'Boolean', value: false },
        { kind: 'Boolean', value: true },
      ],
    })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes And programmatically with empty coll', () => {
    // AST: And(Coll[SBoolean]())  -- empty coll, count=0, no payload bytes.
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
        tag: 'And',
        input: {
          tag: 'Const',
          tpe: { tag: 'SColl', elem: { tag: 'SBoolean' } },
          value: { kind: 'Coll', elem: { tag: 'SBoolean' }, items: [] },
        },
      },
    }
    const out = serializeTree(tree)
    // header + OP_AND + Coll[SBoolean] type code (0x0d) + count=0
    expect(Array.from(out)).toEqual([0x00, 0x96, 0x0d, 0x00])
    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'And') throw new Error('unreachable')
  })
})

describe('Or variant', () => {
  it('round-trips Or(Const Coll[SBoolean] [false, true])', () => {
    // bytes:
    //   0x00       header
    //   0x97       OP_OR
    //   0x0d       SType code Coll[SBoolean]
    //   0x02       count = 2
    //   0x02       bit-packed: bit0=0, bit1=1 = 0b10 = 0x02
    const bytes = new Uint8Array([0x00, 0x97, 0x0d, 0x02, 0x02])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Or')
    if (tree.body.tag !== 'Or') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value).toEqual({
      kind: 'Coll',
      elem: { tag: 'SBoolean' },
      items: [
        { kind: 'Boolean', value: false },
        { kind: 'Boolean', value: true },
      ],
    })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('XorOf variant', () => {
  it('round-trips XorOf(Const Coll[SBoolean] [true, true])', () => {
    // bytes:
    //   0x00       header
    //   0xff       OP_XOR_OF
    //   0x0d       SType code Coll[SBoolean]
    //   0x02       count = 2
    //   0x03       bit-packed: bit0=1, bit1=1 = 0b11 = 0x03
    const bytes = new Uint8Array([0x00, 0xff, 0x0d, 0x02, 0x03])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('XorOf')
    if (tree.body.tag !== 'XorOf') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value).toEqual({
      kind: 'Coll',
      elem: { tag: 'SBoolean' },
      items: [
        { kind: 'Boolean', value: true },
        { kind: 'Boolean', value: true },
      ],
    })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('Xor variant', () => {
  it('round-trips Xor(Coll[SByte] [0xab, 0xcd], Coll[SByte] [0x12, 0x34])', () => {
    // AST: Xor(byteArrayA, byteArrayB) — byte-wise XOR of two SColl(SByte).
    //
    // bytes:
    //   0x00       header
    //   0x9b       OP_XOR
    //   left  = Const(Coll[SByte], [0xab, 0xcd])
    //     0x0e       SType code Coll[SByte] = 12 + 2
    //     0x02       count = 2
    //     0xab 0xcd  raw bytes (NativeColl)
    //   right = Const(Coll[SByte], [0x12, 0x34])
    //     0x0e 0x02 0x12 0x34
    const bytes = new Uint8Array([
      0x00, 0x9b,
      0x0e, 0x02, 0xab, 0xcd,
      0x0e, 0x02, 0x12, 0x34,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Xor')
    if (tree.body.tag !== 'Xor') throw new Error('unreachable')
    expect(tree.body.left.tag).toBe('Const')
    expect(tree.body.right.tag).toBe('Const')
    if (
      tree.body.left.tag !== 'Const' ||
      tree.body.right.tag !== 'Const'
    ) {
      throw new Error('unreachable')
    }
    expect(tree.body.left.tpe).toEqual({
      tag: 'SColl',
      elem: { tag: 'SByte' },
    })
    expect(tree.body.right.tpe).toEqual({
      tag: 'SColl',
      elem: { tag: 'SByte' },
    })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('Atleast variant', () => {
  it('round-trips Atleast(Const SInt 2, Const Coll[SBoolean] [true, false, true])', () => {
    // AST: atLeast(2, Coll(true, false, true))
    // (the wire layer doesn't enforce that input is Coll[SSigmaProp];
    // sigma-rust's runtime guard `Atleast::new` runs higher up.)
    //
    // bytes:
    //   0x00       header
    //   0x98       OP_ATLEAST
    //   bound = Const(SInt 2)
    //     0x04 0x04   SInt code + ZigZag(2)=4
    //   input = Const(Coll[SBoolean], [true, false, true])
    //     0x0d 0x03 0x05   (see And test for breakdown)
    const bytes = new Uint8Array([
      0x00, 0x98,
      0x04, 0x04,
      0x0d, 0x03, 0x05,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Atleast')
    if (tree.body.tag !== 'Atleast') throw new Error('unreachable')
    expect(tree.body.bound.tag).toBe('Const')
    expect(tree.body.input.tag).toBe('Const')
    if (
      tree.body.bound.tag !== 'Const' ||
      tree.body.input.tag !== 'Const'
    ) {
      throw new Error('unreachable')
    }
    expect(tree.body.bound.value).toEqual({ kind: 'Int', value: 2 })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('BoolToSigmaProp variant', () => {
  it('round-trips BoolToSigmaProp(Const SBoolean true)', () => {
    // AST: sigmaProp(true)
    //
    // bytes:
    //   0x00       header
    //   0xd1       OP_BOOL_TO_SIGMA_PROP
    //   0x01 0x01  input = Const(SBoolean true)
    const bytes = new Uint8Array([0x00, 0xd1, 0x01, 0x01])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('BoolToSigmaProp')
    if (tree.body.tag !== 'BoolToSigmaProp') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value).toEqual({ kind: 'Boolean', value: true })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes BoolToSigmaProp programmatically', () => {
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
        tag: 'BoolToSigmaProp',
        input: {
          tag: 'Const',
          tpe: { tag: 'SBoolean' },
          value: { kind: 'Boolean', value: false },
        },
      },
    }
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0xd1, 0x01, 0x00])
    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'BoolToSigmaProp') throw new Error('unreachable')
  })
})

describe('Nesting: And containing LogicalNot of a Const', () => {
  it('confirms recursive descent through And + LogicalNot', () => {
    // AST: And(Coll(true, !false))
    //
    // The input is a Const(Coll[SBoolean]) — But here we want to test
    // *recursive Expr nesting* (And's input being NOT a Const Coll but rather
    // an Expr that yields a Coll). For a clean structural test we instead
    // exercise nesting through a LogicalNot wrapping a Const:
    //
    // AST: LogicalNot(And(Const Coll[SBoolean] [true, false]))
    //
    // Confirms LogicalNot.input parses through the dispatcher into another
    // multi-byte variant, exercising the parseExpr recursion.
    const bytes = new Uint8Array([
      0x00,
      0xef, // OP_LOGICAL_NOT
      0x96, // OP_AND
      0x0d, 0x02, 0x01, // Const Coll[SBoolean] [true, false]
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'LogicalNot') throw new Error('unreachable')
    expect(tree.body.input.tag).toBe('And')
    if (tree.body.input.tag !== 'And') throw new Error('unreachable')
    expect(tree.body.input.input.tag).toBe('Const')

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})
