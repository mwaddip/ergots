import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 15 tests: round-trips for the numeric type-conversion variants
 * `Upcast` and `Downcast`. Drives the parsers end-to-end via the
 * `parseTree` / `serializeTree` envelope so per-variant code runs in its
 * real call context.
 *
 * Wire format (sigma-rust `mir/upcast.rs`, `mir/downcast.rs`):
 *   - `Upcast`   (opcode 0x7e): `[opcode] [input Expr] [target SType]`
 *   - `Downcast` (opcode 0x7d): `[opcode] [input Expr] [target SType]`
 *
 * Both variants share the exact same byte layout: serialize the input
 * Expr, then serialize the target SType. Mirrors sigma-rust's
 * `<Upcast as SigmaSerializable>::sigma_serialize` and the analogous
 * `Downcast` impl (both `mir/{upcast,downcast}.rs:60-72`).
 *
 * SType primitive codes used here (see `wire/serialize-stype.ts:82-108`):
 *   SByte=2  SShort=3  SInt=4  SLong=5  SBigInt=6
 *
 * Sigma-rust's `Upcast::new` / `Downcast::new` reject non-numeric source
 * or target types (`mir/upcast.rs:31-49`, `mir/downcast.rs:31-49`); we do
 * NOT enforce that at the wire layer — semantic validity is a later-pass
 * concern. The wire-layer parser is permissive (same convention as
 * Negation / BitInversion / BoolToSigmaProp in Task 14).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/upcast.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/downcast.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:131-132
 */

describe('Upcast variant', () => {
  it('round-trips Upcast(Const SInt 1) -> SLong', () => {
    // AST: upcast(1: SInt, SLong)
    //
    // bytes:
    //   0x00       header (v0, no size, no segregation)
    //   0x7e       OP_UPCAST
    //   0x04 0x02  input = Const(SInt, ZigZag(1)=2)
    //   0x05       target SType = SLong
    const bytes = new Uint8Array([0x00, 0x7e, 0x04, 0x02, 0x05])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Upcast')
    if (tree.body.tag !== 'Upcast') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SLong' })
    expect(tree.body.input.tag).toBe('Const')
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SInt' })
    expect(tree.body.input.value).toEqual({ kind: 'Int', value: 1 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips Upcast(Const SByte 7) -> SLong', () => {
    // AST: upcast(7: SByte, SLong)
    //
    // bytes:
    //   0x00       header
    //   0x7e       OP_UPCAST
    //   0x02 0x07  input = Const(SByte 7)  -- SByte values are raw bytes
    //   0x05       target SType = SLong
    const bytes = new Uint8Array([0x00, 0x7e, 0x02, 0x07, 0x05])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Upcast') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SLong' })
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SByte' })
    expect(tree.body.input.value).toEqual({ kind: 'Byte', value: 7 })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Upcast(Const SShort 100) -> SBigInt', () => {
    // AST: upcast(100: SShort, SBigInt)
    //
    // SShort uses ZigZag VLQ: ZigZag(100) = 200 = 0xc8 -> VLQ [0xc8, 0x01]
    // bytes:
    //   0x00       header
    //   0x7e       OP_UPCAST
    //   0x03       Const tpe-code = SShort
    //   0xc8 0x01  ZigZag VLQ(100)
    //   0x06       target SType = SBigInt
    const bytes = new Uint8Array([0x00, 0x7e, 0x03, 0xc8, 0x01, 0x06])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Upcast') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SBigInt' })
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SShort' })
    expect(tree.body.input.value).toEqual({ kind: 'Short', value: 100 })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes Upcast programmatically', () => {
    // AST: upcast(5: SInt, SLong)
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
        tag: 'Upcast',
        input: {
          tag: 'Const',
          tpe: { tag: 'SInt' },
          value: { kind: 'Int', value: 5 },
        },
        tpe: { tag: 'SLong' },
      },
    }
    const out = serializeTree(tree)
    // header + OP_UPCAST + SInt(0x04) + ZigZag(5)=10=0x0a + SLong(0x05)
    expect(Array.from(out)).toEqual([0x00, 0x7e, 0x04, 0x0a, 0x05])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'Upcast') throw new Error('unreachable')
    expect(reparsed.body.tpe).toEqual({ tag: 'SLong' })
  })
})

describe('Downcast variant', () => {
  it('round-trips Downcast(Const SLong 1) -> SInt', () => {
    // AST: downcast(1L, SInt)
    //
    // bytes:
    //   0x00       header
    //   0x7d       OP_DOWNCAST
    //   0x05 0x02  input = Const(SLong, ZigZag(1)=2)
    //   0x04       target SType = SInt
    const bytes = new Uint8Array([0x00, 0x7d, 0x05, 0x02, 0x04])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Downcast')
    if (tree.body.tag !== 'Downcast') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SInt' })
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SLong' })
    expect(tree.body.input.value).toEqual({ kind: 'Long', value: 1n })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips Downcast(Const SBigInt 42) -> SByte', () => {
    // AST: downcast(42.toBigInt, SByte)
    //
    // SBigInt is encoded as `[len:u8] [bytes(BigEndian, two's complement)]`
    // (see test/svalue.test.ts lines 103-112). 42 fits in one byte (0x2a,
    // non-negative). len = 1.
    // bytes:
    //   0x00       header
    //   0x7d       OP_DOWNCAST
    //   0x06       Const tpe-code = SBigInt
    //   0x01       len = 1
    //   0x2a       value = 42
    //   0x02       target SType = SByte
    const bytes = new Uint8Array([0x00, 0x7d, 0x06, 0x01, 0x2a, 0x02])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Downcast') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SByte' })
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SBigInt' })
    expect(tree.body.input.value).toEqual({ kind: 'BigInt', value: 42n })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Downcast(Const SInt 100) -> SShort', () => {
    // AST: downcast(100: SInt, SShort)
    //
    // ZigZag(100) = 200 = 0xc8 -> VLQ [0xc8, 0x01]
    // bytes:
    //   0x00       header
    //   0x7d       OP_DOWNCAST
    //   0x04       Const tpe-code = SInt
    //   0xc8 0x01  ZigZag VLQ(100)
    //   0x03       target SType = SShort
    const bytes = new Uint8Array([0x00, 0x7d, 0x04, 0xc8, 0x01, 0x03])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Downcast') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SShort' })
    if (tree.body.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SInt' })
    expect(tree.body.input.value).toEqual({ kind: 'Int', value: 100 })
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes Downcast programmatically', () => {
    // AST: downcast(5L, SInt)
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
        tag: 'Downcast',
        input: {
          tag: 'Const',
          tpe: { tag: 'SLong' },
          value: { kind: 'Long', value: 5n },
        },
        tpe: { tag: 'SInt' },
      },
    }
    const out = serializeTree(tree)
    // header + OP_DOWNCAST + SLong(0x05) + ZigZag(5)=10=0x0a + SInt(0x04)
    expect(Array.from(out)).toEqual([0x00, 0x7d, 0x05, 0x0a, 0x04])

    const reparsed = parseTree(out)
    if (reparsed.body.tag !== 'Downcast') throw new Error('unreachable')
    expect(reparsed.body.tpe).toEqual({ tag: 'SInt' })
  })
})

describe('Nesting: Upcast wrapping Downcast', () => {
  it('round-trips Upcast(Downcast(Const SLong 1, SInt), SLong)', () => {
    // AST: upcast(downcast(1L, SInt), SLong)
    //
    // Confirms recursive descent: the inner Downcast is parsed and
    // serialized by parseExpr / serializeExpr inside the outer Upcast.
    //
    // bytes:
    //   0x00            header
    //   0x7e            OP_UPCAST
    //     0x7d          OP_DOWNCAST
    //       0x05 0x02   input = Const(SLong, ZigZag(1)=2)
    //       0x04        target SType = SInt
    //     0x05          target SType = SLong
    const bytes = new Uint8Array([0x00, 0x7e, 0x7d, 0x05, 0x02, 0x04, 0x05])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Upcast') throw new Error('unreachable')
    expect(tree.body.tpe).toEqual({ tag: 'SLong' })
    if (tree.body.input.tag !== 'Downcast') throw new Error('unreachable')
    expect(tree.body.input.tpe).toEqual({ tag: 'SInt' })
    if (tree.body.input.input.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.input.input.tpe).toEqual({ tag: 'SLong' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })
})
