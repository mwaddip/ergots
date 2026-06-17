import { describe, it, expect } from 'vitest'
import { serializeTree } from '../../src/wire/ergo-tree'
import { parseParsedTree as parseTree } from '../_helpers'
import type { ErgoTree, Expr } from '../../src/mir/types'

/**
 * Task 19 tests: 9 collection operations round-trips.
 *
 * Variants covered: `Append`, `ByIndex`, `Exists`, `Filter`, `Fold`, `ForAll`,
 * `Map`, `SizeOf`, `Slice`.
 *
 * Drives the parsers end-to-end via the `parseTree` / `serializeTree`
 * envelope so per-variant code runs in its real call context.
 *
 * Wire formats (verified against sigma-rust source):
 *   - Append (0xb3):    [input Expr] [col_2 Expr]
 *   - ByIndex (0xb2):   [input Expr] [index Expr] [default Option<Box<Expr>>]
 *                       Option encoding: tag 0x00 (None) or 0x01 (Some) +
 *                       inner Expr. Generic `Option<Box<T>>` from
 *                       `serialization/serializable.rs:212-231`.
 *   - Exists (0xae):    [input Expr] [condition Expr]    -- condition is SFunc
 *   - Filter (0xb5):    [input Expr] [condition Expr]    -- condition is SFunc
 *   - Fold (0xb0):      [input Expr] [zero Expr] [fold_op Expr]
 *                       fold_op is SFunc taking STuple(zero_tpe, elem_tpe)
 *                       → zero_tpe (single 2-tuple destructured to (acc, elem))
 *   - ForAll (0xaf):    [input Expr] [condition Expr]    -- condition is SFunc
 *   - Map (0xad):       [input Expr] [mapper Expr]       -- mapper is SFunc
 *   - SizeOf (0xb1):    [input Expr]
 *   - Slice (0xb4):     [input Expr] [from Expr] [until Expr]
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_*.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (MAP=0xad, EXISTS=0xae, FOR_ALL=0xaf, FOLD=0xb0, SIZE_OF=0xb1,
 *      BY_INDEX=0xb2, APPEND=0xb3, SLICE=0xb4, FILTER=0xb5)
 */

/** Helper: build a minimal v0 ErgoTree envelope around a single Expr body. */
function buildTree(body: Expr): ErgoTree {
  return {
    header: {
      version: 0,
      hasSize: false,
      constantSegregation: false,
      rawHeader: 0x00,
    },
    constantTypes: [],
    constants: [],
    body,
  }
}

describe('CollSize variant', () => {
  it('round-trips SizeOf(OUTPUTS) (single Expr arg, GlobalVars input)', () => {
    // AST: OUTPUTS.size
    //
    // bytes:
    //   0x00       header
    //   0xb1       OP_SIZE_OF
    //   0xa5       OUTPUTS (GlobalVars unit-variant opcode)
    const bytes = new Uint8Array([0x00, 0xb1, 0xa5])

    const tree = parseTree(bytes)
    expect(tree.body.tag).toBe('SizeOf')
    if (tree.body.tag !== 'SizeOf') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Outputs' })

    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual(Array.from(bytes))
  })

  it('builds and serializes SizeOf programmatically with INPUTS input', () => {
    const tree = buildTree({
      tag: 'SizeOf',
      input: { tag: 'GlobalVars', kind: 'Inputs' },
    })
    // header + OP_SIZE_OF + INPUTS
    expect(Array.from(serializeTree(tree))).toEqual([0x00, 0xb1, 0xa4])
  })
})

describe('CollAppend variant', () => {
  it('round-trips Append(INPUTS, OUTPUTS) (two collections concatenated)', () => {
    // AST: INPUTS ++ OUTPUTS  (both are Coll[Box] in sigma)
    //
    // bytes:
    //   0x00       header
    //   0xb3       OP_APPEND
    //   0xa4       INPUTS
    //   0xa5       OUTPUTS
    const bytes = new Uint8Array([0x00, 0xb3, 0xa4, 0xa5])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Append') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Inputs' })
    expect(tree.body.col2).toEqual({ tag: 'GlobalVars', kind: 'Outputs' })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes Append with two Coll[Int] literals programmatically', () => {
    // AST: Coll[Int](1) ++ Coll[Int](2)
    //
    // bytes:
    //   0x00       header
    //   0xb3       OP_APPEND
    //   0x83       OP_COLL (left)
    //   0x01       items_count VLQ = 1
    //   0x04       elem_tpe = SInt
    //   0x04 0x02  item = Const(SInt 1)  (ZigZag(1) = 2)
    //   0x83       OP_COLL (right)
    //   0x01       items_count VLQ = 1
    //   0x04       elem_tpe = SInt
    //   0x04 0x04  item = Const(SInt 2)  (ZigZag(2) = 4)
    const tree = buildTree({
      tag: 'Append',
      input: {
        tag: 'Collection',
        kind: 'Exprs',
        elemTpe: { tag: 'SInt' },
        items: [{ tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } }],
      },
      col2: {
        tag: 'Collection',
        kind: 'Exprs',
        elemTpe: { tag: 'SInt' },
        items: [{ tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } }],
      },
    })
    const out = serializeTree(tree)
    expect(Array.from(out)).toEqual([
      0x00,
      0xb3,
      0x83, 0x01, 0x04, 0x04, 0x02,
      0x83, 0x01, 0x04, 0x04, 0x04,
    ])

    // round-trip back
    const re = parseTree(out)
    if (re.body.tag !== 'Append') throw new Error('unreachable')
    expect(re.body.input.tag).toBe('Collection')
    expect(re.body.col2.tag).toBe('Collection')
  })
})

describe('CollSlice variant', () => {
  it('round-trips Slice(OUTPUTS, 0, 3) (three Expr args)', () => {
    // AST: OUTPUTS.slice(0, 3)
    //
    // bytes:
    //   0x00       header
    //   0xb4       OP_SLICE
    //   0xa5       OUTPUTS
    //   0x04 0x00  Const(SInt 0)   (ZigZag(0) = 0)
    //   0x04 0x06  Const(SInt 3)   (ZigZag(3) = 6)
    const bytes = new Uint8Array([0x00, 0xb4, 0xa5, 0x04, 0x00, 0x04, 0x06])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Slice') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Outputs' })
    if (tree.body.from.tag !== 'Const') throw new Error('unreachable')
    if (tree.body.until.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.from.value).toEqual({ kind: 'Int', value: 0 })
    expect(tree.body.until.value).toEqual({ kind: 'Int', value: 3 })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('CollByIndex variant', () => {
  it('round-trips ByIndex(OUTPUTS, 0) without default (None)', () => {
    // AST: OUTPUTS(0)   -- strict Coll.apply
    //
    // bytes:
    //   0x00       header
    //   0xb2       OP_BY_INDEX
    //   0xa5       OUTPUTS
    //   0x04 0x00  Const(SInt 0)
    //   0x00       default = None (Option tag byte)
    const bytes = new Uint8Array([0x00, 0xb2, 0xa5, 0x04, 0x00, 0x00])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'ByIndex') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Outputs' })
    if (tree.body.index.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.index.value).toEqual({ kind: 'Int', value: 0 })
    expect(tree.body.default).toBeNull()

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('round-trips ByIndex with default (Some)', () => {
    // AST: INPUTS.getOrElse(2, SELF)   -- typed as Coll.getOrElse with SBox default
    //
    // We use Coll[Box] (INPUTS), index Const(SInt 2), default = SELF
    // (GlobalVars.SelfBox = 0xa7).
    //
    // bytes:
    //   0x00       header
    //   0xb2       OP_BY_INDEX
    //   0xa4       INPUTS
    //   0x04 0x04  Const(SInt 2)   (ZigZag(2) = 4)
    //   0x01       default = Some (Option tag byte)
    //   0xa7       SELF_BOX
    const bytes = new Uint8Array([0x00, 0xb2, 0xa4, 0x04, 0x04, 0x01, 0xa7])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'ByIndex') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Inputs' })
    if (tree.body.index.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.index.value).toEqual({ kind: 'Int', value: 2 })
    expect(tree.body.default).toEqual({ tag: 'GlobalVars', kind: 'SelfBox' })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })

  it('builds and serializes ByIndex with default=null programmatically', () => {
    const tree = buildTree({
      tag: 'ByIndex',
      input: { tag: 'GlobalVars', kind: 'Outputs' },
      index: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 7 } },
      default: null,
    })
    // header + OP_BY_INDEX + OUTPUTS + Const(SInt 7, ZigZag=14=0x0e) + 0x00 (None)
    expect(Array.from(serializeTree(tree))).toEqual([
      0x00, 0xb2, 0xa5, 0x04, 0x0e, 0x00,
    ])
  })

  it('ByIndex: nonzero-noncanonical tag 0x02 accepted as Some (already faithful — pin against regression)', () => {
    // ByIndex.default uses generic Option<Box<Expr>> decoding: tag != 0 → Some.
    // This pin verifies the already-correct `tag !== 0` behavior survives future
    // "harmonization" to an exact-1 check. sigma-rust ByIndexSerializer.scala:34
    // `r.getOption(r.parseExpr())` — same scorex-util getOption semantics.
    //
    // tag-02 twin of the tag-01 Some round-trip: replace byte 5 (0x01 → 0x02).
    const bytes02 = new Uint8Array([0x00, 0xb2, 0xa4, 0x04, 0x04, 0x02, 0xa7])
    // canonical twin (tag = 0x01):
    const bytes01 = new Uint8Array([0x00, 0xb2, 0xa4, 0x04, 0x04, 0x01, 0xa7])
    const tree02 = parseTree(bytes02)
    const tree01 = parseTree(bytes01)
    // Identical MIR:
    expect(tree02.body).toEqual(tree01.body)
    // Serializer emits canonical 0x01:
    expect(Array.from(serializeTree(tree02))).toEqual(Array.from(bytes01))
  })
})

/*
 * Common lambda layout: every following test uses
 *   (v0: SBox) => Const(true)
 * encoded as:
 *   0xd9       OP_FUNC_VALUE
 *   0x01       args count VLQ = 1
 *   0x00       arg.id VLQ = 0
 *   0x63       arg.tpe = SBox (primitive code 99)
 *   0x01 0x01  body = Const(SBoolean true)  (SBoolean=0x01, true=0x01)
 *
 * Tests using this lambda use 5 bytes of body + 2-byte lambda header = 7 bytes.
 * The fact that the lambda body doesn't reference v0 is irrelevant to the
 * wire-layer: the parser doesn't enforce ValUse referencing — that's a
 * higher-layer concern. What matters is round-trip byte equality.
 */
const TRUE_BOX_PRED_LAMBDA_BYTES = [
  0xd9, // OP_FUNC_VALUE
  0x01, // args count
  0x00, // arg.id = 0
  0x63, // arg.tpe = SBox
  0x01, 0x01, // body = Const(SBoolean true)
] as const

describe('CollExists variant', () => {
  it('round-trips Exists(INPUTS, (v0: SBox) => true)', () => {
    // AST: INPUTS.exists((v0: SBox) => true)
    //
    // bytes:
    //   0x00       header
    //   0xae       OP_EXISTS
    //   0xa4       INPUTS                  -- input
    //   [lambda]                            -- condition (see TRUE_BOX_PRED_LAMBDA_BYTES)
    const bytes = new Uint8Array([
      0x00,
      0xae,
      0xa4,
      ...TRUE_BOX_PRED_LAMBDA_BYTES,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Exists') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Inputs' })
    expect(tree.body.condition.tag).toBe('FuncValue')

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('CollFilter variant', () => {
  it('round-trips Filter(INPUTS, (v0: SBox) => true)', () => {
    const bytes = new Uint8Array([
      0x00,
      0xb5, // OP_FILTER
      0xa4, // INPUTS
      ...TRUE_BOX_PRED_LAMBDA_BYTES,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Filter') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Inputs' })
    expect(tree.body.condition.tag).toBe('FuncValue')

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('CollForall variant', () => {
  it('round-trips ForAll(OUTPUTS, (v0: SBox) => true)', () => {
    const bytes = new Uint8Array([
      0x00,
      0xaf, // OP_FOR_ALL
      0xa5, // OUTPUTS
      ...TRUE_BOX_PRED_LAMBDA_BYTES,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'ForAll') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Outputs' })
    expect(tree.body.condition.tag).toBe('FuncValue')

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('CollMap variant', () => {
  it('round-trips Map(INPUTS, (v0: SBox) => v0) — id mapper', () => {
    // AST: INPUTS.map((v0: SBox) => v0)
    //
    // Uses ValUse(0) in the body (not Const) to exercise the val-def-type-store
    // bookkeeping inside FuncValue parsing.
    //
    // bytes:
    //   0x00       header
    //   0xad       OP_MAP
    //   0xa4       INPUTS
    //   0xd9       OP_FUNC_VALUE
    //   0x01       args count = 1
    //   0x00       arg.id = 0
    //   0x63       arg.tpe = SBox
    //   0x72 0x00  body = ValUse(0)
    const bytes = new Uint8Array([
      0x00,
      0xad,
      0xa4,
      0xd9, 0x01, 0x00, 0x63, 0x72, 0x00,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Map') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Inputs' })
    if (tree.body.mapper.tag !== 'FuncValue') throw new Error('unreachable')
    expect(tree.body.mapper.args).toEqual([{ id: 0, tpe: { tag: 'SBox' } }])
    if (tree.body.mapper.body.tag !== 'ValUse') throw new Error('unreachable')
    expect(tree.body.mapper.body.valId).toBe(0)
    expect(tree.body.mapper.body.tpe).toEqual({ tag: 'SBox' })

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('CollFold variant', () => {
  it('round-trips Fold(INPUTS, 0L, (v0: STuple(SLong, SBox)) => 0L)', () => {
    // AST: INPUTS.fold(0L, (acc: SLong, b: SBox) => 0L)
    //
    // Encoded as Fold(input, zero, foldOp). foldOp is a single-arg
    // FuncValue whose arg is a 2-tuple (zero_tpe, elem_tpe) = (SLong, SBox).
    // The body simply returns Const(SLong 0L) — we don't care about
    // semantics, only round-trip stability.
    //
    // STuple(SLong, SBox) encoding: PAIR2 + SLong_prim (5) = 72+5 = 77 = 0x4d,
    // then serialize the non-primitive operand (SBox). Per
    // `serialize-stype.ts::serializePair`: since SBox is NOT an embeddable
    // primitive but SLong is, we hit the "only first is primitive" branch
    // → emit PAIR1 + SLong_prim. PAIR1 = 60, prim(SLong)=5 → 65 = 0x41,
    // then serialize(SBox) → 0x63.
    //
    // bytes:
    //   0x00       header
    //   0xb0       OP_FOLD
    //   0xa4       INPUTS                  -- input
    //   0x05 0x00  Const(SLong 0)          -- zero (ZigZag VLQ(0L) = 0)
    //   0xd9       OP_FUNC_VALUE           -- fold_op begin
    //   0x01       args count = 1
    //   0x00       arg.id = 0
    //   0x41 0x63  arg.tpe = STuple(SLong, SBox) via PAIR1+SLong, then SBox
    //   0x05 0x00  body = Const(SLong 0)
    const bytes = new Uint8Array([
      0x00,
      0xb0,
      0xa4,
      0x05, 0x00,
      0xd9, 0x01, 0x00, 0x41, 0x63, 0x05, 0x00,
    ])

    const tree = parseTree(bytes)
    if (tree.body.tag !== 'Fold') throw new Error('unreachable')
    expect(tree.body.input).toEqual({ tag: 'GlobalVars', kind: 'Inputs' })
    if (tree.body.zero.tag !== 'Const') throw new Error('unreachable')
    expect(tree.body.zero.value).toEqual({ kind: 'Long', value: 0n })
    if (tree.body.foldOp.tag !== 'FuncValue') throw new Error('unreachable')
    expect(tree.body.foldOp.args).toEqual([
      {
        id: 0,
        tpe: { tag: 'STuple', items: [{ tag: 'SLong' }, { tag: 'SBox' }] },
      },
    ])

    expect(Array.from(serializeTree(tree))).toEqual(Array.from(bytes))
  })
})

describe('Build-and-serialize: combined collection ops over SELF.tokens', () => {
  it('builds Map(SELF.tokens, mapper) programmatically and round-trips', () => {
    // Exercise composition: Map over a derived collection. Here we just use
    // SELF (a SBox) wrapped in a Coll via OUTPUTS for type simplicity; the
    // intent is to ensure two consecutive opcode bytes (OP_MAP + OUTPUTS +
    // FuncValue) parse correctly through the dispatcher.
    const tree = buildTree({
      tag: 'Map',
      input: { tag: 'GlobalVars', kind: 'Outputs' },
      mapper: {
        tag: 'FuncValue',
        args: [{ id: 0, tpe: { tag: 'SBox' } }],
        body: { tag: 'ValUse', valId: 0, tpe: { tag: 'SBox' } },
      },
    })

    const bytes = serializeTree(tree)
    const re = parseTree(bytes)
    if (re.body.tag !== 'Map') throw new Error('unreachable')
    expect(re.body.input).toEqual({ tag: 'GlobalVars', kind: 'Outputs' })
    expect(re.body.mapper.tag).toBe('FuncValue')
    // Second round-trip determinism.
    expect(Array.from(serializeTree(re))).toEqual(Array.from(bytes))
  })
})
