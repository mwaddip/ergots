/**
 * The JVM's node construction at parse (sigma-state 6.0.6; spec
 * docs/specs/2026-09-30-jvm-node-construction-design.md §§3-4; facts/ergoscript-wire.md, "Node
 * construction"). parseExpr builds each node with `checkBuild(node, 'parse', treeVersion)` when its
 * arm returns, which is when the JVM builds it: right after the node's own children are read, and
 * before any later byte.
 *
 * Every tree is built with the helpers and parsed from its bytes. Each case is named after the local
 * sigma-state 6.0.6 probe case that fixed the JVM's verdict (tree mode, checkType = true:
 * `ErgoTreeSerializer.deserializeErgoTree` under `VersionContext(3, the tree's version)`), and asserts
 * that ergots' bytes are the bytes the probe was given. The JVM's exception class is noted beside each
 * verdict. A construction failure is never a ValidationException, so a sized tree rejects on it and
 * does not degrade.
 */
import { describe, it, expect } from 'vitest'
import { ReaderError } from '@ergots/scorex'
import { parseTree } from '../../src/wire/ergo-tree'
import { ExprParseError } from '../../src/wire/errors'
import { checkBuild } from '../../src/wire/check-build'
import { ExprTpeError, exprTpe, recordedCallType } from '../../src/mir/expr-tpe'
import { isOwnSAny } from '../../src/mir/jvm-types'
import { isUnparsedTree, NOTYPE_JVM } from '../../src/mir/types'
import type { ErgoTree, Expr, ParsedErgoTree, SType } from '../../src/mir/types'
import {
  Apply, BI, BitInversion, BitOr, Block, ByIndex, Coll, Ctx, DR, Downcast, EQ, Filter, GT, GV, If, MC,
  Negation, OptionGet, OptionIsDefined, PC, Plus, SigmaAnd, SigmaPropBytes, SigmaPropIsProven, SizeOf,
  T, TreeLookup, Upcast, ValDef, ValUse, bool, bytes, collBool, collInt, dead, hex, int, long, sp,
  treeBytes,
} from '../_helpers/mir-build'

type Outcome =
  | { status: 'parsed'; tree: ParsedErgoTree }
  | { status: 'degraded'; error: Error }
  | { status: 'rejected'; error: unknown }

/** The parse under the box rules (checkType), as the probe's tree mode and the JVM's box parser. */
function parseBox(b: Uint8Array): Outcome {
  let t: ErgoTree
  try {
    t = parseTree(b, { checkType: true })
  } catch (error) {
    return { status: 'rejected', error }
  }
  return isUnparsedTree(t) ? { status: 'degraded', error: t.error } : { status: 'parsed', tree: t }
}

/** The tree's bytes, checked against the bytes the probe case was given. */
function probed(name: string, body: Expr, header: number, probedHex: string): Uint8Array {
  const b = treeBytes(body, header)
  expect(hex(b), `${name}: the probed bytes`).toBe(probedHex)
  return b
}

function expectRejected(o: Outcome, cls: typeof ExprParseError | typeof ExprTpeError, code: string): void {
  expect(o.status).toBe('rejected')
  if (o.status !== 'rejected') return
  expect(o.error).toBeInstanceOf(cls)
  expect((o.error as { code?: string }).code).toBe(code)
}

function expectParsed(o: Outcome): ParsedErgoTree {
  if (o.status !== 'parsed') {
    const why = o.status === 'rejected' ? String(o.error) : `degraded: ${o.error.message}`
    throw new Error(`expected the tree to parse, got ${why}`)
  }
  return o.tree
}

/** `{ val v1 = e; sigmaProp(true) }`: `e` is built, and only the ValDef store reads its type. */
const inVal = (e: Expr): Expr => Block([ValDef(1, e)], sp(bool(true)))
/** Apply(Int 0, [Int 0]): the JVM's NoType (sigma/ast/values.scala:1247-1251). */
const APPLY_NO = Apply(int(0), [int(0)])
/** CONTEXT.preHeader.timestamp (105:3 on 101:3): a Long in the JVM; ergots' own SAny (residual 1). */
const TS = PC(105, 3, PC(101, 3, Ctx))

describe('Upcast and Downcast require a numeric input (trees.scala:398, 431)', () => {
  // The probe cases' bytes, by case name (the tree mode's hex).
  const PROBED: Record<string, string> = {
    'T3-Upcast-bool-sized-root': '0808d1937e0101050500',
    'T3-Upcast-bool-unsized-root': '00d1937e0101050500',
    'T3-Upcast-bool-valdef': '00d801d6017e010105d10101',
    'T3-Upcast-bool-dead': '00d1950100937e01010505000101',
    'T3-Upcast-bool-coll-item': '00d193b18301057e0101050402',
    'T3-Downcast-bool-sized-root': '0808d1937d0101040400',
    'T3-Downcast-bool-unsized-root': '00d1937d0101040400',
    'T3-Downcast-bool-valdef': '00d801d6017d010104d10101',
    'T3-Downcast-bool-dead': '00d1950100937d01010404000101',
    'T3-Downcast-bool-coll-item': '00d193b18301047d0101040402',
    'T3-Upcast-collInt-sized-root': '0808d1937e1000050500',
    'T3-Upcast-collInt-unsized-root': '00d1937e1000050500',
    'T3-Upcast-collInt-valdef': '00d801d6017e100005d10101',
    'T3-Upcast-collInt-dead': '00d1950100937e10000505000101',
    'T3-Upcast-collInt-coll-item': '00d193b18301057e1000050402',
    'T3-Downcast-collInt-sized-root': '0808d1937d1000040400',
    'T3-Downcast-collInt-unsized-root': '00d1937d1000040400',
    'T3-Downcast-collInt-valdef': '00d801d6017d100004d10101',
    'T3-Downcast-collInt-dead': '00d1950100937d10000404000101',
    'T3-Downcast-collInt-coll-item': '00d193b18301047d1000040402',
    'T3-Upcast-BI-sized-root': '0810d1937eb2860204000400040000050500',
    'T3-Upcast-BI-unsized-root': '00d1937eb2860204000400040000050500',
    'T3-Upcast-BI-valdef': '00d801d6017eb286020400040004000005d10101',
    'T3-Upcast-BI-dead': '00d1950100937eb28602040004000400000505000101',
    'T3-Upcast-BI-coll-item': '00d193b18301057eb2860204000400040000050402',
    'T3-Downcast-BI-sized-root': '0810d1937db2860204000400040000040400',
    'T3-Downcast-BI-unsized-root': '00d1937db2860204000400040000040400',
    'T3-Downcast-BI-valdef': '00d801d6017db286020400040004000004d10101',
    'T3-Downcast-BI-dead': '00d1950100937db28602040004000400000404000101',
    'T3-Downcast-BI-coll-item': '00d193b18301047db2860204000400040000040402',
    'T3-Upcast-ApplyNo-sized-root': '080cd1937eda0400010400050500',
    'T3-Upcast-ApplyNo-unsized-root': '00d1937eda0400010400050500',
    'T3-Upcast-ApplyNo-valdef': '00d801d6017eda040001040005d10101',
    'T3-Upcast-ApplyNo-dead': '00d1950100937eda04000104000505000101',
    'T3-Upcast-ApplyNo-coll-item': '00d193b18301057eda0400010400050402',
    'T3-Downcast-ApplyNo-sized-root': '080cd1937dda0400010400040400',
    'T3-Downcast-ApplyNo-unsized-root': '00d1937dda0400010400040400',
    'T3-Downcast-ApplyNo-valdef': '00d801d6017dda040001040004d10101',
    'T3-Downcast-ApplyNo-dead': '00d1950100937dda04000104000404000101',
    'T3-Downcast-ApplyNo-coll-item': '00d193b18301047dda0400010400040402',
    'T3-Upcast-GV-sized-root': '080ad1937ee4e30161050500',
    'T3-Upcast-GV-unsized-root': '00d1937ee4e30161050500',
    'T3-Upcast-GV-valdef': '00d801d6017ee4e3016105d10101',
    'T3-Upcast-GV-dead': '00d1950100937ee4e301610505000101',
    'T3-Upcast-GV-coll-item': '00d193b18301057ee4e30161050402',
    'T3-Downcast-GV-sized-root': '080ad1937de4e30161040400',
    'T3-Downcast-GV-unsized-root': '00d1937de4e30161040400',
    'T3-Downcast-GV-valdef': '00d801d6017de4e3016104d10101',
    'T3-Downcast-GV-dead': '00d1950100937de4e301610404000101',
    'T3-Downcast-GV-coll-item': '00d193b18301047de4e30161040402',
  }
  // The inputs: a Boolean, a collection, the JVM's SAny (ByIndex over a tuple, and GetVar of type code
  // 97), and its NoType (an Apply of an Int), none an SNumericType.
  const SOURCES: [string, Expr][] = [['bool', bool(true)], ['collInt', collInt([])], ['BI', BI], ['ApplyNo', APPLY_NO], ['GV', GV]]
  const ARMS: [string, (x: Expr, t: SType) => Expr, SType, Expr][] = [
    ['Upcast', Upcast, T.Long, long(0)],
    ['Downcast', Downcast, T.Int, int(0)],
  ]
  for (const [source, x] of SOURCES) {
    for (const [arm, build, target, zero] of ARMS) {
      const node = build(x, target)
      const POSITIONS: [string, Expr, number][] = [
        ['sized-root', sp(EQ(node, zero)), 0x08],
        ['unsized-root', sp(EQ(node, zero)), 0x00],
        ['valdef', inVal(node), 0x00],
        ['dead', dead(EQ(node, zero)), 0x00],
        ['coll-item', sp(EQ(SizeOf(Coll(target, [node])), int(1))), 0x00],
      ]
      for (const [position, body, header] of POSITIONS) {
        const name = `T3-${arm}-${source}-${position}`
        it(`${name}: rejects (the JVM: SerializerException from IllegalArgumentException)`, () => {
          const b = probed(name, body, header, PROBED[name]!)
          expectRejected(parseBox(b), ExprParseError, 'numeric-cast-input-not-numeric')
        })
      }
    }
  }
})

describe("Upcast's target type is cast to SNumericType first (NumericCastSerializer.scala:20-24)", () => {
  it('T3-Upcast-target-bool-int-input: rejects (the JVM: ClassCastException from asNumType)', () => {
    const b = probed('T3-Upcast-target-bool-int-input', inVal(Upcast(int(1), T.Bool)), 0x00, '00d801d6017e040201d10101')
    expectRejected(parseBox(b), ExprParseError, 'numeric-cast-target-not-numeric')
  })
  it('T3-Upcast-target-bool-bool-input: the target cast comes before the input check (the JVM: ClassCastException)', () => {
    const b = probed('T3-Upcast-target-bool-bool-input', inVal(Upcast(bool(true), T.Bool)), 0x00, '00d801d6017e010101d10101')
    expectRejected(parseBox(b), ExprParseError, 'numeric-cast-target-not-numeric')
  })
})

describe('a construction failure is thrown before any later byte is read (spec §4)', () => {
  // SigmaAnd(sigmaProp(Upcast(x, Long) == 0L), sigmaProp(Coll[Byte](5000 x 7).size == 0)) in a sized
  // v0 tree: the byte collection runs past the 4096-byte window after the Upcast is built.
  const order = (x: Expr): Expr => SigmaAnd(sp(EQ(Upcast(x, T.Long), long(0))), sp(EQ(SizeOf(bytes(new Array(5000).fill(7))), int(0))))
  const tail = 'd193b10e8827' + '07'.repeat(5000) + '0400'
  it('T3-order-A1: an Upcast of a Boolean rejects, and does not degrade (the JVM: SerializerException from IllegalArgumentException)', () => {
    const b = probed('T3-order-A1', order(bool(true)), 0x08, '089a27ea02d1937e0101050500' + tail)
    expectRejected(parseBox(b), ExprParseError, 'numeric-cast-input-not-numeric')
  })
  it('T3-order-A2-control: an Upcast of an Int builds, and the window degrades the tree (the JVM: unparsed, rule 1014)', () => {
    const b = probed('T3-order-A2-control', order(int(1)), 0x08, '089a27ea02d1937e0402050500' + tail)
    const o = parseBox(b)
    expect(o.status).toBe('degraded')
    if (o.status === 'degraded') {
      expect(o.error).toBeInstanceOf(ReaderError)
      expect((o.error as ReaderError).code).toBe('position-limit-exceeded')
    }
  })
})

describe('Negation and BitInversion require a numeric input or NoType (trees.scala:882, 900)', () => {
  it('T3-Negation-bool: rejects (the JVM: SerializerException from IllegalArgumentException)', () => {
    const b = probed('T3-Negation-bool', inVal(Negation(bool(true))), 0x00, '00d801d601f00101d10101')
    expectRejected(parseBox(b), ExprParseError, 'negation-input-not-numeric')
  })
  it('T3-Negation-notype: NoType passes isNumTypeOrNoType, and the tree parses (the JVM: parsed)', () => {
    const b = probed('T3-Negation-notype', inVal(Negation(APPLY_NO)), 0x00, '00d801d601f0da0400010400d10101')
    expectParsed(parseBox(b))
  })
  it("T3-Negation-BI: the JVM's SAny rejects (the JVM: SerializerException from IllegalArgumentException)", () => {
    const b = probed('T3-Negation-BI', inVal(Negation(BI)), 0x00, '00d801d601f0b2860204000400040000d10101')
    expectRejected(parseBox(b), ExprParseError, 'negation-input-not-numeric')
  })
  it('T3-BitInversion-bool: rejects (the JVM: SerializerException from IllegalArgumentException)', () => {
    const b = probed('T3-BitInversion-bool', inVal(BitInversion(bool(true))), 0x00, '00d801d601f10101d10101')
    expectRejected(parseBox(b), ExprParseError, 'bit-inversion-input-not-numeric')
  })
  it('T3-BitInversion-notype: NoType passes, and the tree parses (the JVM: parsed)', () => {
    const b = probed('T3-BitInversion-notype', inVal(BitInversion(APPLY_NO)), 0x00, '00d801d601f1da0400010400d10101')
    expectParsed(parseBox(b))
  })
  it("T3-BitInversion-BI: the JVM's SAny rejects (the JVM: SerializerException from IllegalArgumentException)", () => {
    const b = probed('T3-BitInversion-BI', inVal(BitInversion(BI)), 0x00, '00d801d601f1b2860204000400040000d10101')
    expectRejected(parseBox(b), ExprParseError, 'bit-inversion-input-not-numeric')
  })
})

describe('BitOp requires both operands numeric or NoType, and always reads the right one (trees.scala:913)', () => {
  it('T3-BitOr-bool-int: rejects (the JVM: SerializerException from IllegalArgumentException)', () => {
    const b = probed('T3-BitOr-bool-int', inVal(BitOr(bool(true), int(1))), 0x00, '00d801d601f201010402d10101')
    expectRejected(parseBox(b), ExprParseError, 'bit-op-operand-not-numeric')
  })
  it("T3-BitOr-bool-FilterBI: the require's message reads the right operand's type, whose cast wins (the JVM: ClassCastException)", () => {
    const b = probed('T3-BitOr-bool-FilterBI', inVal(BitOr(bool(true), Filter(BI))), 0x00,
      '00d801d601f20101b5b2860204000400040000d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-BitOr-int-FilterBI: a numeric left operand, then the right one is read (the JVM: ClassCastException)', () => {
    const b = probed('T3-BitOr-int-FilterBI', inVal(BitOr(int(1), Filter(BI))), 0x00,
      '00d801d601f20402b5b2860204000400040000d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-BitOr-notype-int: a NoType left operand passes (the JVM: parsed)', () => {
    const b = probed('T3-BitOr-notype-int', inVal(BitOr(APPLY_NO, int(1))), 0x00, '00d801d601f2da04000104000402d10101')
    expectParsed(parseBox(b))
  })
})

describe("the relations' check2, the builder's (SigmaBuilder.scala:286-295, 686-704)", () => {
  it('T3-EQ-int-long-v3: from v3 the builder does not upcast, so the types differ (the JVM: ConstraintFailed)', () => {
    const b = probed('T3-EQ-int-long-v3', sp(EQ(int(1), long(1))), 0x0b, '0b06d19304020502')
    expectRejected(parseBox(b), ExprParseError, 'relation-operand-type-mismatch')
  })
  it('T3-EQ-int-long-v0: before v3 the builder upcasts the Int to Long (the JVM: parsed)', () => {
    const b = probed('T3-EQ-int-long-v0', sp(EQ(int(1), long(1))), 0x00, '00d19304020502')
    expectParsed(parseBox(b))
  })
  it('T3-GT-true-true-v0: an ordering needs numeric operands; the pair is packed as 0x85 (the JVM: ConstraintFailed)', () => {
    const b = probed('T3-GT-true-true-v0', sp(GT(bool(true), bool(true))), 0x00, '00d1918503')
    expectRejected(parseBox(b), ExprParseError, 'relation-operand-not-numeric')
  })
  it('T3-GT-true-true-v3: the same at v3 (the JVM: ConstraintFailed)', () => {
    const b = probed('T3-GT-true-true-v3', sp(GT(bool(true), bool(true))), 0x0b, '0b04d1918503')
    expectRejected(parseBox(b), ExprParseError, 'relation-operand-not-numeric')
  })
  it("T3-EQ-notype-sany: NoType is not the JVM's SAny (the JVM: ConstraintFailed)", () => {
    const b = probed('T3-EQ-notype-sany', sp(EQ(APPLY_NO, BI)), 0x00, '00d193da0400010400b2860204000400040000')
    expectRejected(parseBox(b), ExprParseError, 'relation-operand-type-mismatch')
  })
  it("T3-EQ-ownsany-int: ergots' own SAny passes (residual 1; the JVM's Long == Long parses)", () => {
    const b = probed('T3-EQ-ownsany-int', sp(EQ(TS, long(1))), 0x00, '00d193db6903db6503fe0502')
    expectParsed(parseBox(b))
  })
  it("T3-EQ-ownsany-int1-v0: ergots' own SAny passes (the JVM upcasts the Int to the timestamp's Long: parsed)", () => {
    const b = probed('T3-EQ-ownsany-int1-v0', sp(EQ(TS, int(1))), 0x00, '00d193db6903db6503fe0402')
    expectParsed(parseBox(b))
  })
  it("T3-GT-bool-FilterBI-v0: check2 reads both operands' types before its constraint (the JVM: ClassCastException)", () => {
    const b = probed('T3-GT-bool-FilterBI-v0', sp(GT(bool(true), Filter(BI))), 0x00, '00d1910101b5b2860204000400040000d90101040101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-interim-dead-EQ-notype-int-v0: a dead EQ(NoType, Int) rejects at parse (the JVM: ConstraintFailed)', () => {
    // Task 2 made NOTYPE_JVM a type; the pre-eval gate's structural SAny wildcard let this through.
    const b = probed('T3-interim-dead-EQ-notype-int-v0', dead(EQ(APPLY_NO, int(0))), 0x00, '00d195010093da040001040004000101')
    expectRejected(parseBox(b), ExprParseError, 'relation-operand-type-mismatch')
  })
})

describe("a ValUse bound to an Apply of a non-function carries the store's NoType", () => {
  const block = (result: Expr) => Block([ValDef(1, APPLY_NO)], result)
  const V1 = ValUse(1, NOTYPE_JVM)
  it('T3-notype-window-valuse: EQ(ValUse, Int) rejects (the JVM: ConstraintFailed, NoType != SInt)', () => {
    const b = probed('T3-notype-window-valuse', block(sp(EQ(V1, int(0)))), 0x00, '00d801d601da0400010400d19372010400')
    expectRejected(parseBox(b), ExprParseError, 'relation-operand-type-mismatch')
  })
  it('T3-notype-window-coll: rejects at the item assert, before the EQ is built (the JVM: AssertionError)', () => {
    const b = probed('T3-notype-window-coll', block(sp(EQ(Coll(T.Int, [V1]), int(0)))), 0x00, '00d801d601da0400010400d19383010472010400')
    expectRejected(parseBox(b), ExprParseError, 'collection-item-type-mismatch')
  })
  it('T3-notype-window-eq-self: EQ(ValUse, ValUse) parses, and the ValUse is typed NOTYPE_JVM (the JVM: parsed)', () => {
    const b = probed('T3-notype-window-eq-self', block(sp(EQ(V1, V1))), 0x00, '00d801d601da0400010400d19372017201')
    const t = expectParsed(parseBox(b))
    const root = (t.body as { result: { input: { left: Expr } } }).result.input.left
    expect(root.tag).toBe('ValUse')
    expect(exprTpe(root, 0)).toBe(NOTYPE_JVM)
  })
})

describe('the child types a node reads while it is built', () => {
  it('T3-If-root-FilterBI-false: If reads all three branches (Quadruple.opType, trees.scala:1313; the JVM: ClassCastException)', () => {
    const b = probed('T3-If-root-FilterBI-false', If(bool(true), sp(bool(true)), Filter(BI)), 0x00,
      '00950101d10101b5b2860204000400040000d90101040101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
    // The read is the node's own, so a parse without checkType rejects too.
    expect(() => parseTree(b)).toThrow(ExprTpeError)
  })
  it("T3-If-cond-FilterBI: If reads its condition's type (the JVM: ClassCastException)", () => {
    const b = probed('T3-If-cond-FilterBI', inVal(If(Filter(BI), int(0), int(0))), 0x00,
      '00d801d60195b5b2860204000400040000d9010104010104000400d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-Plus-right-FilterBI: arithmetic reads both operands (val opType, trees.scala:708; the JVM: ClassCastException)', () => {
    const b = probed('T3-Plus-right-FilterBI', inVal(Plus(int(1), Filter(BI))), 0x00,
      '00d801d6019a0402b5b2860204000400040000d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-Plus-right-FilterBI-v3: from v3 too, where the node types from its left operand (the JVM: ClassCastException)', () => {
    const b = probed('T3-Plus-right-FilterBI-v3', inVal(Plus(int(1), Filter(BI))), 0x0b,
      '0b1bd801d6019a0402b5b2860204000400040000d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-OptionIsDefined-FilterBI: reads its input (transformers.scala:656; the JVM: ClassCastException)', () => {
    const b = probed('T3-OptionIsDefined-FilterBI', inVal(OptionIsDefined(Filter(BI))), 0x00,
      '00d801d601e6b5b2860204000400040000d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-SigmaPropBytes-FilterBI: reads its input (transformers.scala:336; the JVM: ClassCastException)', () => {
    const b = probed('T3-SigmaPropBytes-FilterBI', inVal(SigmaPropBytes(Filter(BI))), 0x00,
      '00d801d601d0b5b2860204000400040000d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-SigmaPropIsProven-FilterBI: reads its input (transformers.scala:324; the JVM: ClassCastException)', () => {
    const b = probed('T3-SigmaPropIsProven-FilterBI', inVal(SigmaPropIsProven(Filter(BI))), 0x00,
      '00d801d601cfb5b2860204000400040000d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-TreeLookup-FilterBI-proof: TreeLookup reads its three children (trees.scala:1313; the JVM: ClassCastException)', () => {
    const b = probed('T3-TreeLookup-FilterBI-proof', inVal(TreeLookup(int(0), int(0), Filter(BI))), 0x00,
      '00d801d601b704000400b5b2860204000400040000d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it('T3-TreeLookup-control: its children are not type-checked (the JVM: parsed)', () => {
    const b = probed('T3-TreeLookup-control', inVal(TreeLookup(int(0), int(0), int(0))), 0x00, '00d801d601b7040004000400d10101')
    expectParsed(parseBox(b))
  })
  it("T3-SizeOf-FilterBI-in-EQ: SizeOf reads nothing, and Filter's type is read only where it is needed (the JVM: parsed)", () => {
    const b = probed('T3-SizeOf-FilterBI-in-EQ', sp(EQ(SizeOf(Filter(BI)), int(0))), 0x00, '00d193b1b5b2860204000400040000d901010401010400')
    expectParsed(parseBox(b))
  })
})

describe("ergots' own SAny passes the numeric checks (residual 1)", () => {
  // The JVM types the timestamp as Long, so each of these parses there.
  const CASES: [string, Expr, number, string][] = [
    ['T3-ownsany-GT-v3', sp(GT(TS, long(1))), 0x0b, '0b0bd191db6903db6503fe0502'],
    ['T3-ownsany-Upcast', inVal(Upcast(TS, T.Long)), 0x00, '00d801d6017edb6903db6503fe05d10101'],
    ['T3-ownsany-Negation', inVal(Negation(TS)), 0x00, '00d801d601f0db6903db6503fed10101'],
    ['T3-ownsany-BitOr', inVal(BitOr(TS, long(1))), 0x00, '00d801d601f2db6903db6503fe0502d10101'],
  ]
  for (const [name, body, header, probedHex] of CASES) {
    it(`${name}: parses (the JVM: parsed)`, () => {
      expectParsed(parseBox(probed(name, body, header, probedHex)))
    })
  }
})

describe("a call's reads, gated on ergots' method catalog (MethodCallSerializer.scala:77-97)", () => {
  it('T3-uncat-pair-FilterBI-sized: a pair the JVM does not know fails its lookup before any read, so the tree degrades (the JVM: unparsed, rule 1016)', () => {
    // Collection method 200 (12:200): SMethod.fromIds fails (rule 1016) before the object's type is read.
    const b = probed('T3-uncat-pair-FilterBI-sized', sp(EQ(PC(12, 200, Filter(BI)), int(0))), 0x08,
      '0818d193db0cc8b5b2860204000400040000d901010401010400')
    const o = parseBox(b)
    expect(o.status).toBe('degraded')
    if (o.status !== 'degraded') return
    expect(o.error).toBeInstanceOf(ExprParseError)
    expect((o.error as ExprParseError).code).toBe('method-unknown')
  })
  it("T9-uncat-known-pair-FilterBI-sized: a pair the JVM knows and ergots does not catalogue reads nothing, so ergots parses (residual 1; the JVM: ClassCastException)", () => {
    // Option.get (36:3): fromIds finds it, and specializeFor reads the object's type
    // (PropertyCallSerializer.scala:47), a Filter over the JVM's SAny, whose type read casts.
    const b = probed('T9-uncat-known-pair-FilterBI-sized', sp(EQ(PC(36, 3, Filter(BI)), int(0))), 0x08,
      '0818d193db2403b5b2860204000400040000d901010401010400')
    const t = expectParsed(parseBox(b))
    // The call is recorded as ergots' own SAny.
    const call = (t.body as { input: { left: Expr } }).input.left
    const recorded = recordedCallType(call)
    expect(recorded).toBeDefined()
    expect(isOwnSAny(recorded!)).toBe(true)
  })
  it('T3-cat-get-FilterBI-v3: a catalogued pair reads its object (the JVM: ClassCastException)', () => {
    const b = probed('T3-cat-get-FilterBI-v3', inVal(MC(12, 33, Filter(BI), [int(0)])), 0x0b,
      '0b1ed801d601dc0c21b5b2860204000400040000d90101040101010400d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-class-cast')
  })
  it("T3-cat-get-order-v3: the arguments' types are read before the object's (the JVM: the argument's SInt ClassCastException)", () => {
    const b = probed('T3-cat-get-order-v3', inVal(MC(12, 33, Filter(BI), [Filter(int(1))])), 0x0b,
      '0b25d801d601dc0c21b5b2860204000400040000d9010104010101b50402d90101040101d10101')
    expectRejected(parseBox(b), ExprTpeError, 'filter-input-not-scoll')
  })
  it('T3-recorded-call-type-v3: the parse records the type a catalogued call was built with (values.scala:1355; the JVM: parsed, SSigmaProp)', () => {
    const b = probed('T3-recorded-call-type-v3', OptionGet(MC(12, 33, DR(4, T.Coll(T.SigmaProp), collBool([true])), [int(0)])), 0x0b,
      '0b0ee4dc0c21d50414010d0101010400')
    const t = expectParsed(parseBox(b))
    const call = (t.body as { input: Expr }).input
    expect(call.tag).toBe('MethodCall')
    expect(recordedCallType(call)).toEqual({ tag: 'SOption', elem: { tag: 'SSigmaProp' } })
  })
})

describe('parsing stays linear in the tree (Review Focus 3)', () => {
  it('T3-linear-if-chain-106: an If chain 110 levels deep, the reader maximum, parses in under 200 ms (the JVM: parsed)', () => {
    // sigmaProp(chain == 0), chain = If(true, If(true, ..., 0), 0), 106 Ifs: the root, the EQ, 106 Ifs,
    // the innermost constant and its data read reach 110 levels (SigmaConstants.MaxTreeDepth).
    let chain: Expr = int(0)
    for (let i = 0; i < 106; i++) chain = If(bool(true), chain, int(0))
    const b = probed('T3-linear-if-chain-106', sp(EQ(chain, int(0))), 0x00,
      '00d193' + '950101'.repeat(106) + '0400' + '0400'.repeat(106) + '0400')
    const start = performance.now()
    const t = expectParsed(parseBox(b))
    expect(performance.now() - start).toBeLessThan(200)
    // The type reads are memoized: a second read of a node whose type is a fresh object (the EQ's
    // SBoolean) returns the same object.
    const eq = (t.body as { input: Expr }).input
    expect(exprTpe(eq, 0)).toBe(exprTpe(eq, 0))
  })
  it('T3-linear-if-chain-107: one If more exceeds the depth (the JVM: DeserializeCallDepthExceeded)', () => {
    let chain: Expr = int(0)
    for (let i = 0; i < 107; i++) chain = If(bool(true), chain, int(0))
    const b = probed('T3-linear-if-chain-107', sp(EQ(chain, int(0))), 0x00,
      '00d193' + '950101'.repeat(107) + '0400' + '0400'.repeat(107) + '0400')
    const o = parseBox(b)
    expect(o.status).toBe('rejected')
    if (o.status === 'rejected') expect((o.error as { code?: string }).code).toBe('max-tree-depth-exceeded')
  })
  it('T3-linear-wide-coll: a sized Coll[Coll[Int]] of 400 x 8 Ints parses in under 200 ms (the JVM: parsed)', () => {
    const wide = Coll(T.Coll(T.Int), Array.from({ length: 400 }, () => collInt([0, 0, 0, 0, 0, 0, 0, 0])))
    const b = probed('T3-linear-wide-coll', sp(EQ(SizeOf(wide), int(400))), 0x08,
      '08aa1fd193b183900310' + ('1008' + '00'.repeat(8)).repeat(400) + '04a006')
    const start = performance.now()
    expectParsed(parseBox(b))
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe("checkBuild's two sites (spec §3): 'rebuild', Kiama's dup, makes the constructor's checks only", () => {
  const codeOf = (f: () => unknown): string | undefined => {
    try {
      f()
    } catch (e) {
      return (e as { code?: string }).code
    }
    return undefined
  }
  it("the target type's cast is the serializer's: parse only", () => {
    const node = Upcast(int(1), T.Bool)
    expect(codeOf(() => checkBuild(node, 'parse', 0))).toBe('numeric-cast-target-not-numeric')
    expect(codeOf(() => checkBuild(node, 'rebuild', 0))).toBeUndefined()
  })
  it("the input's require is the constructor's: both sites", () => {
    for (const node of [Upcast(bool(true), T.Long), Downcast(collInt([]), T.Int)]) {
      expect(codeOf(() => checkBuild(node, 'parse', 0))).toBe('numeric-cast-input-not-numeric')
      expect(codeOf(() => checkBuild(node, 'rebuild', 0))).toBe('numeric-cast-input-not-numeric')
    }
    expect(codeOf(() => checkBuild(Negation(bool(true)), 'rebuild', 0))).toBe('negation-input-not-numeric')
    expect(codeOf(() => checkBuild(BitInversion(BI), 'rebuild', 0))).toBe('bit-inversion-input-not-numeric')
    expect(codeOf(() => checkBuild(BitOr(int(1), bool(true)), 'rebuild', 0))).toBe('bit-op-operand-not-numeric')
  })
  it("the constructor's type reads: both sites", () => {
    const node = If(bool(true), int(0), Filter(BI))
    expect(codeOf(() => checkBuild(node, 'parse', 0))).toBe('filter-input-class-cast')
    expect(codeOf(() => checkBuild(node, 'rebuild', 0))).toBe('filter-input-class-cast')
    const cast = ByIndex(int(0), int(0))
    expect(codeOf(() => checkBuild(cast, 'rebuild', 0))).toBe('by-index-input-not-scoll')
  })
  it("check2 is the builder's: parse only", () => {
    for (const node of [EQ(int(1), long(1)), GT(bool(true), bool(true))]) {
      expect(codeOf(() => checkBuild(node, 'parse', 3))).toBeDefined()
      expect(codeOf(() => checkBuild(node, 'rebuild', 3))).toBeUndefined()
    }
  })
  it("a call's reads and its record are the serializer's: parse only", () => {
    const rebuilt = MC(12, 33, collInt([1]), [int(0)])
    checkBuild(rebuilt, 'rebuild', 3)
    expect(recordedCallType(rebuilt)).toBeUndefined()
    const parsed = MC(12, 33, collInt([1]), [int(0)])
    checkBuild(parsed, 'parse', 3)
    expect(recordedCallType(parsed)).toEqual({ tag: 'SOption', elem: { tag: 'SInt' } })
  })
})
