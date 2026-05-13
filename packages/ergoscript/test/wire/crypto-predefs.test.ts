import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 21 tests: round-trips for the 6 single-input crypto / byte-array
 * predefs.
 *
 * All six share the same `OneArgOp` shape (sigma-rust `mir/unary_op.rs`):
 *
 *   [opcode] [input Expr]
 *
 * Opcodes:
 *   - LongToByteArray     0x7a (122) — SLong -> Coll[Byte]
 *   - ByteArrayToBigInt   0x7b (123) — Coll[Byte] -> SBigInt
 *   - ByteArrayToLong     0x7c (124) — Coll[Byte] -> SLong
 *   - CalcBlake2b256      0xcb (203) — Coll[Byte] -> Coll[Byte]
 *   - CalcSha256          0xcc (204) — Coll[Byte] -> Coll[Byte]
 *   - DecodePoint         0xee (238) — Coll[Byte] -> GroupElement
 *
 * Sigma-rust's `try_build` enforces the input post-eval type for each;
 * we do NOT enforce that at the wire layer (same convention as
 * Negation / BitInversion / BoolToSigmaProp in Task 14). The wire-layer
 * parser is permissive — semantic validity is a later-pass concern.
 *
 * Const encoding cheat-sheet for the byte vectors below
 * (see `wire/serialize-stype.ts:82-188`, `wire/serialize-svalue.ts`):
 *   - SLong (5):     ZigZag VLQ value
 *   - SColl(SByte):  type-code 0x0e (= COLL_TYPECODE(12) + SByte(2)),
 *                    then VLQ length, then raw bytes
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/calc_blake2b256.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/calc_sha256.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/byte_array_to_bigint.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/byte_array_to_long.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/decode_point.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/long_to_byte_array.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 */

describe('CalcBlake2b256 variant', () => {
  it('round-trips CalcBlake2b256(Const SColl(SByte) [0xde,0xad])', () => {
    // AST: CalcBlake2b256(Const(SColl(SByte) [0xde, 0xad]))
    //
    // bytes:
    //   0x00            header (v0, no size, no segregation)
    //   0xcb            OP_CALC_BLAKE2B256
    //   0x0e 0x02       Const SColl(SByte), VLQ len=2
    //     0xde 0xad     raw bytes
    const bytes = new Uint8Array([
      0x00,
      0xcb,
      0x0e, 0x02, 0xde, 0xad,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('CalcBlake2b256')
    if (tree.body.tag !== 'CalcBlake2b256') throw new Error('unreachable')
    expect(tree.body.input.tag).toBe('Const')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value.kind).toBe('Coll')
    if (tree.body.input.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.input.value.elem).toEqual({ tag: 'SByte' })
    expect(tree.body.input.value.items).toHaveLength(2)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes CalcBlake2b256 programmatically', () => {
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
        tag: 'CalcBlake2b256',
        input: {
          tag: 'Const',
          tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
          value: {
            kind: 'Coll',
            elem: { tag: 'SByte' },
            items: [
              { kind: 'Byte', value: 1 },
              { kind: 'Byte', value: 2 },
              { kind: 'Byte', value: 3 },
            ],
          },
        },
      },
    }
    const out = serializeTree(tree)
    // header + OP_CALC_BLAKE2B256 + SColl(SByte)(0x0e) + len(3) + [1,2,3]
    expect(Array.from(out)).toEqual([0x00, 0xcb, 0x0e, 0x03, 0x01, 0x02, 0x03])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'CalcBlake2b256') throw new Error('unreachable')
  })
})

describe('CalcSha256 variant', () => {
  it('round-trips CalcSha256(Const SColl(SByte) [0xab,0xcd,0xef])', () => {
    // bytes:
    //   0x00                  header
    //   0xcc                  OP_CALC_SHA256
    //   0x0e 0x03             Const SColl(SByte), VLQ len=3
    //     0xab 0xcd 0xef      raw bytes
    const bytes = new Uint8Array([
      0x00,
      0xcc,
      0x0e, 0x03, 0xab, 0xcd, 0xef,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('CalcSha256')
    if (tree.body.tag !== 'CalcSha256') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value.kind).toBe('Coll')
    if (tree.body.input.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.input.value.items).toHaveLength(3)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('ByteArrayToBigInt variant', () => {
  it('round-trips ByteArrayToBigInt(Const SColl(SByte) [0x2a])', () => {
    // bytes:
    //   0x00          header
    //   0x7b          OP_BYTE_ARRAY_TO_BIGINT
    //   0x0e 0x01     Const SColl(SByte), VLQ len=1
    //     0x2a        raw byte
    const bytes = new Uint8Array([
      0x00,
      0x7b,
      0x0e, 0x01, 0x2a,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('ByteArrayToBigInt')
    if (tree.body.tag !== 'ByteArrayToBigInt') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value.kind).toBe('Coll')
    if (tree.body.input.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.input.value.items).toHaveLength(1)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('ByteArrayToLong variant', () => {
  it('round-trips ByteArrayToLong(Const SColl(SByte) 8 bytes)', () => {
    // bytes:
    //   0x00                                            header
    //   0x7c                                            OP_BYTE_ARRAY_TO_LONG
    //   0x0e 0x08                                       Const SColl(SByte), len=8
    //     0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x2a       raw bytes (BE 42)
    const bytes = new Uint8Array([
      0x00,
      0x7c,
      0x0e, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x2a,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('ByteArrayToLong')
    if (tree.body.tag !== 'ByteArrayToLong') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value.kind).toBe('Coll')
    if (tree.body.input.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.input.value.items).toHaveLength(8)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('DecodePoint variant', () => {
  it('round-trips DecodePoint(Const SColl(SByte) [0x02,0xff])', () => {
    // bytes:
    //   0x00            header
    //   0xee            OP_DECODE_POINT
    //   0x0e 0x02       Const SColl(SByte), len=2
    //     0x02 0xff     raw bytes
    const bytes = new Uint8Array([
      0x00,
      0xee,
      0x0e, 0x02, 0x02, 0xff,
    ])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('DecodePoint')
    if (tree.body.tag !== 'DecodePoint') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.value.kind).toBe('Coll')
    if (tree.body.input.value.kind !== 'Coll') throw new Error('unreachable')
    expect(tree.body.input.value.items).toHaveLength(2)

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})

describe('LongToByteArray variant', () => {
  it('round-trips LongToByteArray(Const SLong 1)', () => {
    // bytes:
    //   0x00          header
    //   0x7a          OP_LONG_TO_BYTE_ARRAY
    //   0x05 0x02     Const SLong, ZigZag(1)=2
    const bytes = new Uint8Array([0x00, 0x7a, 0x05, 0x02])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('LongToByteArray')
    if (tree.body.tag !== 'LongToByteArray') throw new Error('unreachable')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SLong' })
    expect(tree.body.input.value).toEqual({ kind: 'Long', value: 1n })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes LongToByteArray programmatically', () => {
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
        tag: 'LongToByteArray',
        input: {
          tag: 'Const',
          tpe: { tag: 'SLong' },
          value: { kind: 'Long', value: 5n },
        },
      },
    }
    const out = serializeTree(tree)
    // header + OP_LONG_TO_BYTE_ARRAY + SLong(0x05) + ZigZag(5)=10=0x0a
    expect(Array.from(out)).toEqual([0x00, 0x7a, 0x05, 0x0a])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'LongToByteArray') throw new Error('unreachable')
  })
})

describe('Nesting: CalcBlake2b256 wrapping CalcSha256', () => {
  it('round-trips CalcBlake2b256(CalcSha256(Const SColl(SByte) [0x01]))', () => {
    // AST: blake2b256(sha256(Const(SColl(SByte) [0x01])))
    //
    // bytes:
    //   0x00              header
    //   0xcb              OP_CALC_BLAKE2B256
    //     0xcc            OP_CALC_SHA256
    //       0x0e 0x01     Const SColl(SByte) len=1
    //         0x01        raw byte
    const bytes = new Uint8Array([
      0x00,
      0xcb,
      0xcc,
      0x0e, 0x01, 0x01,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'CalcBlake2b256') throw new Error('unreachable')
    if (tree.body.input.tag !== 'CalcSha256') throw new Error('unreachable')
    if (tree.body.input.input.tag !== 'Const') throw new Error('unreachable')

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})
