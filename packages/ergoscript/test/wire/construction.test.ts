import { describe, it, expect } from 'vitest'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Task 18 tests: `Tuple`, `Collection.Exprs`, and `Collection.BoolConstants`
 * round-trips. Drives the parsers end-to-end via the `parseTree` /
 * `serializeTree` envelope so per-variant code runs in its real call context.
 *
 * Wire format reminders (JVM canonical: TupleSerializer.scala):
 *   - `Tuple` (opcode 0x86):
 *       [items_count: u8]            -- raw byte, NOT VLQ; JVM reads via signed
 *                                       getByte() (TupleSerializer.scala:27-36);
 *                                       parse window 0..127 (≥128 sign-extends
 *                                       negative → NegativeArraySizeException).
 *       [item_0: Expr] ... [item_n-1: Expr]
 *   - `Collection.Exprs` (opcode 0x83):
 *       [items_count: u16]           -- VLQ-encoded (Scorex `put_u16` is VLQ).
 *       [elem_tpe: SType]            -- standard SType encoding.
 *       [item_0: Expr] ... [item_n-1: Expr]
 *   - `Collection.BoolConstants` (opcode 0x85):
 *       [items_count: u16]           -- VLQ-encoded.
 *       [packed_bits: ceil(n/8) bytes] -- LSB-first packing, matching
 *                                         `BitVec<u8, Lsb0>` in
 *                                         `sigma-ser::put_bits`.
 *
 * Asymmetry note: sigma-rust's `coll_sigma_parse` ALWAYS returns the `Exprs`
 * arm even when `elem_tpe == SBoolean`; the `BoolConstants` arm is only
 * produced by the dedicated `bool_const_coll_sigma_parse` (driven by the
 * separate `OP_COLL_OF_BOOL_CONST` opcode). On the write side the same
 * `coll_sigma_serialize` peeks `kind` and emits one or the other. We mirror
 * both directions.
 *
 * Cross-reference (JVM canonical):
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/serialization/
 *     TupleSerializer.scala       (parse window 0..127; serialize no gate)
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/serialization/
 *     ErgoTreeSerializer.scala
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/collection.rs  (Coll only)
 *   ~/projects/sigma-rust/sigma-rust/sigma-ser/src/vlq_encode.rs
 *     (put_u16, put_bits, get_u16, get_bits)
 */

describe('Tuple variant', () => {
  it('round-trips Tuple[Int 1, Int 2] (arity 2)', () => {
    // AST: (1, 2)
    //
    // bytes:
    //   0x00       header (v0, no size, no segregation)
    //   0x86       OP_TUPLE
    //   0x02       items_count = 2 (raw u8, NOT VLQ)
    //   0x04 0x02  item_0 = Const(SInt, ZigZag(1) = 2)
    //   0x04 0x04  item_1 = Const(SInt, ZigZag(2) = 4)
    const bytes = new Uint8Array([0x00, 0x86, 0x02, 0x04, 0x02, 0x04, 0x04])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('Tuple')
    if (tree.body.tag !== 'Tuple') throw new Error('unreachable')
    expect(tree.body.items).toHaveLength(2)
    if (tree.body.items[0]!.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.items[1]!.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.items[0]!.value).toEqual({ kind: 'Int', value: 1 })
    expect(tree.body.items[1]!.value).toEqual({ kind: 'Int', value: 2 })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('round-trips Tuple[Int 1, Bool true, Int 2, Bool false] (arity 4, mixed types)', () => {
    // AST: (1, true, 2, false)
    //
    // bytes:
    //   0x00       header
    //   0x86       OP_TUPLE
    //   0x04       items_count = 4
    //   0x04 0x02  item_0 = Const(SInt 1)
    //   0x01 0x01  item_1 = Const(SBoolean true)
    //   0x04 0x04  item_2 = Const(SInt 2)
    //   0x01 0x00  item_3 = Const(SBoolean false)
    const bytes = new Uint8Array([
      0x00,
      0x86,
      0x04,
      0x04, 0x02,
      0x01, 0x01,
      0x04, 0x04,
      0x01, 0x00,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Tuple') throw new Error('unreachable')
    expect(tree.body.items).toHaveLength(4)
    if (tree.body.items[0]!.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.items[1]!.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.items[2]!.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.items[3]!.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.items[0]!.value).toEqual({ kind: 'Int', value: 1 })
    expect(tree.body.items[1]!.value).toEqual({ kind: 'Boolean', value: true })
    expect(tree.body.items[2]!.value).toEqual({ kind: 'Int', value: 2 })
    expect(tree.body.items[3]!.value).toEqual({ kind: 'Boolean', value: false })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes Tuple programmatically', () => {
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
        tag: 'Tuple',
        items: [
          { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 7 } },
          { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: -1 } },
        ],
      },
    }
    // ZigZag(7) = 14 = 0x0e, ZigZag(-1) = 1 = 0x01.
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0x86, 0x02, 0x04, 0x0e, 0x04, 0x01])
  })

  it('arity-1 Tuple EXPR parses and byte-round-trips (JVM TupleSerializer no lower gate)', () => {
    // JVM TupleSerializer.scala:27-36: count via signed getByte(); NO lower
    // arity gate (mkTuple bare, SigmaBuilder.scala:481-482; Tuple.tpe lazy,
    // values.scala:783). Arity-1 parses on the JVM and rejects only at EVAL
    // (values.scala:797 → 'tuple-invalid-arity'). Old sigma-rust BoundedVec
    // [2,255] window was a JVM over-reject fork — retired.
    const bytes = new Uint8Array([0x00, 0x86, 0x01, 0x04, 0x02])
    const tree = parseTree(bytes)
    // Byte-round-trip identity (serialize produces same bytes, re-parses OK).
    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
    // Eval-layer arity gate fires (values.scala:797).
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    expect(captureEvalError(() => evaluateWith(tree, ctx)).code).toBe('tuple-invalid-arity')
  })

  it('arity-1 Tuple EXPR serializes (JVM TupleSerializer.serialize no arity gate)', () => {
    // JVM TupleSerializer.serialize = putUByte(length) + items — NO arity gate.
    // Arity-1 serializes on the JVM (and re-parses). Old sigma-rust
    // [2,255] lower-bound reject was a JVM fork — retired.
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
        tag: 'Tuple',
        items: [
          { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
        ],
      },
    }
    // ZigZag(1) = 2 = 0x02.
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([0x00, 0x86, 0x01, 0x04, 0x02])
  })
})

describe('Collection variant', () => {
  it('round-trips Collection.Exprs[SInt, [1, 2, 3]]', () => {
    // AST: Coll[Int](1, 2, 3) encoded via OP_COLL (no bool optimization).
    //
    // bytes:
    //   0x00       header
    //   0x83       OP_COLL
    //   0x03       items_count VLQ = 3
    //   0x04       elem_tpe = SInt
    //   0x04 0x02  item_0 = Const(SInt 1)
    //   0x04 0x04  item_1 = Const(SInt 2)
    //   0x04 0x06  item_2 = Const(SInt 3) (ZigZag(3) = 6)
    const bytes = new Uint8Array([
      0x00,
      0x83,
      0x03,
      0x04,
      0x04, 0x02,
      0x04, 0x04,
      0x04, 0x06,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Collection') throw new Error('unreachable')
    expect(tree.body.kind).toBe('Exprs')
    if (tree.body.kind !== 'Exprs') throw new Error('unreachable')
    expect(tree.body.elemTpe).toEqual({ tag: 'SInt' })
    expect(tree.body.items).toHaveLength(3)
    if (tree.body.items[0]!.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.items[1]!.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.items[2]!.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.items[0]!.value).toEqual({ kind: 'Int', value: 1 })
    expect(tree.body.items[1]!.value).toEqual({ kind: 'Int', value: 2 })
    expect(tree.body.items[2]!.value).toEqual({ kind: 'Int', value: 3 })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Collection.BoolConstants[true, false, true] (3 bits in 1 byte)', () => {
    // AST: Coll[Boolean](true, false, true) encoded via OP_COLL_OF_BOOL_CONST.
    //
    // bytes:
    //   0x00       header
    //   0x85       OP_COLL_OF_BOOL_CONST
    //   0x03       items_count VLQ = 3
    //   0x05       packed bits = 0b00000101 (LSB-first: bit0=1, bit1=0, bit2=1)
    const bytes = new Uint8Array([0x00, 0x85, 0x03, 0x05])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Collection') throw new Error('unreachable')
    expect(tree.body.kind).toBe('BoolConstants')
    if (tree.body.kind !== 'BoolConstants') throw new Error('unreachable')
    expect(tree.body.items).toEqual([true, false, true])

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips Collection.BoolConstants spanning two packed bytes (9 items)', () => {
    // 9 booleans → ceil(9/8) = 2 packed bytes.
    // items = [t, f, t, f, t, f, t, f, t]
    //   byte0 (bits 0..7) = 0b01010101 = 0x55
    //   byte1 (bit 8)     = 0b00000001 = 0x01
    const bytes = new Uint8Array([0x00, 0x85, 0x09, 0x55, 0x01])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Collection') throw new Error('unreachable')
    if (tree.body.kind !== 'BoolConstants') throw new Error('unreachable')
    expect(tree.body.items).toEqual([
      true, false, true, false, true, false, true, false, true,
    ])

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips empty Collection.Exprs (SInt element type)', () => {
    // bytes:
    //   0x00       header
    //   0x83       OP_COLL
    //   0x00       items_count VLQ = 0
    //   0x04       elem_tpe = SInt
    const bytes = new Uint8Array([0x00, 0x83, 0x00, 0x04])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Collection') throw new Error('unreachable')
    if (tree.body.kind !== 'Exprs') throw new Error('unreachable')
    expect(tree.body.elemTpe).toEqual({ tag: 'SInt' })
    expect(tree.body.items).toEqual([])

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips empty Collection.BoolConstants (0 items → 0 packed bytes)', () => {
    // bytes:
    //   0x00       header
    //   0x85       OP_COLL_OF_BOOL_CONST
    //   0x00       items_count VLQ = 0; ceil(0/8) = 0 packed bytes
    const bytes = new Uint8Array([0x00, 0x85, 0x00])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Collection') throw new Error('unreachable')
    if (tree.body.kind !== 'BoolConstants') throw new Error('unreachable')
    expect(tree.body.items).toEqual([])

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes Collection.Exprs[SBoolean] programmatically (Exprs path, not bool optimization)', () => {
    // The two arms are independent on the write side: a `kind: 'Exprs'`
    // Collection with `elemTpe = SBoolean` emits via OP_COLL (0x83), not
    // OP_COLL_OF_BOOL_CONST (0x85). This mirrors sigma-rust where the
    // optimization is decided at construction (`Collection::new`) by trying
    // to extract bools from each item; if any non-Const item is present the
    // collection stays as `Exprs`.
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
        tag: 'Collection',
        kind: 'Exprs',
        elemTpe: { tag: 'SBoolean' },
        items: [
          { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
          { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: false } },
        ],
      },
    }
    const out = serializeTree(tree)
    // header + OP_COLL + count=2 + SBoolean(0x01) + Const(0x01)0x01 + Const(0x01)0x00
    expect(Array.from(out)).toEqual([0x00, 0x83, 0x02, 0x01, 0x01, 0x01, 0x01, 0x00])
  })
})
