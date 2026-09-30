/**
 * The JVM's mid-parse checks, each at the JVM's read position (sigma-state 6.0.6; spec
 * docs/specs/2026-09-30-jvm-node-construction-design.md §3, "In the parse arms"; facts/ergoscript-wire.md,
 * "Node construction"). The JVM makes these checks inside a node's parse, before it reads the node's
 * later bytes; the parse hook (`checkBuild`) runs only once a node's arm has returned.
 * - ConcreteCollection: `assert(v.tpe == tItem)` after each item and before the next
 *   (ConcreteCollectionSerializer.scala:35-39), an AssertionError.
 * - BlockValue: each item is cast to `BlockItem` as it is read (BlockValueSerializer.scala:38-40), a
 *   ClassCastException.
 * - MethodCall: from v3, `assert(args.nonEmpty)` after the arguments and before the method lookup and the
 *   explicit type arguments (MethodCallSerializer.scala:52-56), an AssertionError.
 * - ByIndex: before v3, the index's `upcastTo(SInt)` right after the index and before the default flag
 *   (ByIndexSerializer.scala:27-36; syntax.scala:168-177), an AssertionError.
 * - ExtractRegisterAs: `findRegisterByIndex(id).get` right after the id byte and before the type
 *   (ExtractRegisterAsSerializer.scala:25-31; ErgoBox.scala:197-198), a NoSuchElementException.
 * SelectField has no index check at parse: the constructor's tuple cast, then its index, decide
 * (transformers.scala:294-295; exprTpe's arm, which checkBuild runs).
 *
 * None of these throws is a ValidationException, so a sized tree rejects on it even where a later read
 * would have degraded it. Every tree is parsed from its bytes. Each case is named after the local
 * sigma-state 6.0.6 probe case that fixed the JVM's verdict (tree mode, checkType = true unless noted:
 * `ErgoTreeSerializer.deserializeErgoTree` under `VersionContext(3, the tree's version)`; spend mode for
 * a script decoded at spend), asserts that ergots' bytes are the bytes the probe was given, and notes the
 * JVM's exception class.
 */
import { describe, it, expect } from 'vitest'
import { ReaderError } from '@ergots/scorex'
import { parseTree } from '../../src/wire/ergo-tree'
import { ExprParseError } from '../../src/wire/errors'
import { isJvmClassCast } from '../../src/wire/jvm-exceptions'
import { ExprTpeError } from '../../src/mir/expr-tpe'
import { isUnparsedTree } from '../../src/mir/types'
import type { ErgoTree, Expr, ParsedErgoTree, SType, SValue } from '../../src/mir/types'
import { evaluate } from '../../src/eval/evaluate'
import type { EvalOpts } from '../../src/eval/eval-context'
import { GROUP_GENERATOR_BYTES } from '../../src/eval/_group-generator'
import { captureEvalError, parseParsedTree } from '../_helpers'
import {
  Apply, BI, Block, ByIndex, Coll, Ctx, DC, EQ, GetVar, OptionGet, OptionIsDefined, PC, Plus, SelectField,
  SigmaAnd, SizeOf, T, Tuple, ValDef, bool, bytes, collInt, dead, exprBytes, hex, int, long, sp, treeBytes,
} from '../_helpers/mir-build'

type Outcome =
  | { status: 'parsed'; tree: ParsedErgoTree }
  | { status: 'degraded'; error: Error }
  | { status: 'rejected'; error: unknown }

/** The parse under the box rules (checkType), as the probe's tree mode and the JVM's box parser. */
function parseBox(b: Uint8Array, checkType = true): Outcome {
  let t: ErgoTree
  try {
    t = parseTree(b, { checkType })
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

/** Bytes the writer cannot produce (an index of 0, a 0xdc call without arguments), as the probe was given them. */
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)))

function expectRejected(o: Outcome, cls: typeof ExprParseError | typeof ExprTpeError, code: string): void {
  if (o.status !== 'rejected') {
    throw new Error(`expected a reject with ${code}, got ${o.status === 'parsed' ? 'parsed' : `degraded: ${o.error.message}`}`)
  }
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

/** The rule-1014 degrade: a checked read past the tree's 4096-byte window (facts/ergoscript-wire.md). */
function expectWindowDegrade(o: Outcome): void {
  if (o.status !== 'degraded') throw new Error(`expected a degrade, got ${o.status === 'parsed' ? 'parsed' : String(o.error)}`)
  expect(o.error).toBeInstanceOf(ReaderError)
  expect((o.error as ReaderError).code).toBe('position-limit-exceeded')
}

const BYTE0: Expr = { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 0 } }
const SHORT0: Expr = { tag: 'Const', tpe: { tag: 'SShort' }, value: { kind: 'Short', value: 0 } }
const BIGINT0: Expr = { tag: 'Const', tpe: { tag: 'SBigInt' }, value: { kind: 'BigInt', value: 0n } }
/** Apply(Int 0, [Int 0]): the JVM's NoType (sigma/ast/values.scala:1247-1251). */
const APPLY_NO = Apply(int(0), [int(0)])
/** CONTEXT.preHeader.timestamp (105:3 on 101:3): a Long in the JVM; ergots' own SAny (residual 1). */
const TS = PC(105, 3, PC(101, 3, Ctx))
const SELF: Expr = { tag: 'GlobalVars', kind: 'SelfBox' }
const ERA = (input: Expr, registerId: number, elemTpe: SType): Expr => ({ tag: 'ExtractRegisterAs', input, registerId, elemTpe })
/** Coll[Byte](5000 × 7): a bulk read that starts inside the 4096-byte window and ends past it. */
const BIG = bytes(new Array(5000).fill(7))
/** An Int whose own read crosses the window: Plus reads its right operand past it. */
const OVERFLOW_INT = Plus(SizeOf(BIG), int(1))
const RUN = '07'.repeat(5000)

describe('ConcreteCollection: the item assert, after each item and before the next (ConcreteCollectionSerializer.scala:35-39)', () => {
  it('T4-coll-long-plus-int-long-v0 (B1): v0 Coll[Long](Plus(Int 1, Long 2)) parses: the builder upcasts before v3 (the JVM: parsed)', () => {
    const b = probed('T4-coll-long-plus-int-long-v0', sp(EQ(SizeOf(Coll(T.Long, [Plus(int(1), long(2))])), int(1))), 0x00,
      '00d193b18301059a040205040402')
    expectParsed(parseBox(b))
  })
  it('T4-coll-long-plus-int-long-v3 (B2): from v3 Plus is an Int, and the item assert rejects (the JVM: AssertionError)', () => {
    const b = probed('T4-coll-long-plus-int-long-v3', sp(EQ(SizeOf(Coll(T.Long, [Plus(int(1), long(2))])), int(1))), 0x0b,
      '0b0dd193b18301059a040205040402')
    expectRejected(parseBox(b), ExprParseError, 'collection-item-type-mismatch')
  })
  it('T4-coll-int-plus-int-long-v0 (B3): v0 Coll[Int](Plus(Int 1, Long 2)) rejects: the upcast makes it a Long (the JVM: AssertionError)', () => {
    const b = probed('T4-coll-int-plus-int-long-v0', sp(EQ(SizeOf(Coll(T.Int, [Plus(int(1), long(2))])), int(1))), 0x00,
      '00d193b18301049a040205040402')
    expectRejected(parseBox(b), ExprParseError, 'collection-item-type-mismatch')
  })
  it("T4-coll-any-notype (C2): Coll[Any](Apply(Int 0, [Int 0])) rejects: NoType is not the JVM's SAny (the JVM: AssertionError)", () => {
    const b = probed('T4-coll-any-notype', sp(EQ(SizeOf(Coll(T.Any, [APPLY_NO])), int(1))), 0x00, '00d193b1830161da04000104000402')
    expectRejected(parseBox(b), ExprParseError, 'collection-item-type-mismatch')
  })
  it("T4-coll-any-BI: Coll[Any](ByIndex(tuple)) parses: the JVM's SAny equals itself (the JVM: parsed)", () => {
    const b = probed('T4-coll-any-BI', sp(EQ(SizeOf(Coll(T.Any, [BI])), int(1))), 0x00, '00d193b1830161b28602040004000400000402')
    expectParsed(parseBox(b))
  })
  it('T4-coll-int-second-long: a Coll[Int] whose second item is a Long rejects (the JVM: AssertionError)', () => {
    const b = probed('T4-coll-int-second-long', sp(EQ(SizeOf(Coll(T.Int, [int(1), long(2)])), int(2))), 0x00, '00d193b1830204040205040404')
    expectRejected(parseBox(b), ExprParseError, 'collection-item-type-mismatch')
  })
  it("T4b-coll-long-ownsany-item: an item typed as ergots' own SAny passes (the JVM types it Long: parsed)", () => {
    const b = probed('T4b-coll-long-ownsany-item', sp(EQ(SizeOf(Coll(T.Long, [TS])), int(1))), 0x00, '00d193b1830105db6903db6503fe0402')
    expectParsed(parseBox(b))
  })
  it("T4b-coll-any-ownsany-item: ergots parses Coll[Any](CONTEXT.preHeader.timestamp), which the JVM rejects (AssertionError): residual 1", () => {
    // ergots cannot type 105:3, so the assert cannot see the JVM's Long (the method catalog, residual 1).
    const b = probed('T4b-coll-any-ownsany-item', sp(EQ(SizeOf(Coll(T.Any, [TS])), int(1))), 0x00, '00d193b1830161db6903db6503fe0402')
    expectParsed(parseBox(b))
  })

  describe('the assert comes before any later byte, so a sized tree rejects and does not degrade', () => {
    it('T4-coll-order-long-item-then-window: a sized tree whose Coll[Int] holds Long 1, then a read past the window (the JVM: AssertionError)', () => {
      const body = SigmaAnd(sp(EQ(SizeOf(Coll(T.Int, [long(1)])), int(1))), sp(EQ(SizeOf(BIG), int(0))))
      const b = probed('T4-coll-order-long-item-then-window', body, 0x08, `089c27ea02d193b183010405020402d193b10e8827${RUN}0400`)
      expectRejected(parseBox(b), ExprParseError, 'collection-item-type-mismatch')
    })
    it("T4b-coll-order-in-coll-long-then-overflow-item: the assert follows item 0, before item 1's read crosses the window (the JVM: AssertionError)", () => {
      const body = sp(EQ(SizeOf(Coll(T.Int, [long(1), OVERFLOW_INT])), int(2)))
      const b = probed('T4b-coll-order-in-coll-long-then-overflow-item', body, 0x08, `089927d193b183020405029ab10e8827${RUN}04020404`)
      expectRejected(parseBox(b), ExprParseError, 'collection-item-type-mismatch')
    })
    it('T4b-coll-order-in-coll-control: with an Int item 0, item 1 is read past the window and the tree degrades (the JVM: unparsed, rule 1014)', () => {
      const body = sp(EQ(SizeOf(Coll(T.Int, [int(1), OVERFLOW_INT])), int(2)))
      const b = probed('T4b-coll-order-in-coll-control', body, 0x08, `089927d193b183020404029ab10e8827${RUN}04020404`)
      expectWindowDegrade(parseBox(b))
    })
  })
})

describe('BlockValue: each item is a ValDef as it is read (BlockValueSerializer.scala:38-40)', () => {
  it('T4-block-item-not-valdef: Block([Int 1], sigmaProp(true)) rejects (the JVM: ClassCastException, ConstantNode is no BlockItem)', () => {
    const b = probed('T4-block-item-not-valdef', Block([int(1)], sp(bool(true))), 0x00, '00d8010402d10101')
    expectRejected(parseBox(b), ExprParseError, 'block-value-item-not-val-def')
  })
  it('T4b-block-second-item-not-valdef: a second item that is no ValDef rejects (the JVM: ClassCastException)', () => {
    const b = probed('T4b-block-second-item-not-valdef', Block([ValDef(1, int(1)), int(2)], sp(bool(true))), 0x00, '00d802d60104020404d10101')
    expectRejected(parseBox(b), ExprParseError, 'block-value-item-not-val-def')
  })
  it("T4b-block-order-then-overflow-item: the cast follows item 0, before item 1's read crosses the window (the JVM: ClassCastException)", () => {
    const body = Block([int(1), ValDef(1, OVERFLOW_INT)], sp(bool(true)))
    const b = probed('T4b-block-order-then-overflow-item', body, 0x08, `089827d8020402d6019ab10e8827${RUN}0402d10101`)
    expectRejected(parseBox(b), ExprParseError, 'block-value-item-not-val-def')
  })
  it('T4b-block-order-control: with a ValDef item 0, item 1 is read past the window and the tree degrades (the JVM: unparsed, rule 1014)', () => {
    const body = Block([ValDef(2, int(1)), ValDef(1, OVERFLOW_INT)], sp(bool(true)))
    const b = probed('T4b-block-order-control', body, 0x08, `089a27d802d6020402d6019ab10e8827${RUN}0402d10101`)
    expectWindowDegrade(parseBox(b))
  })
})

// Moved from test/eval/validate-method-call-arity.test.ts: the check was a pre-eval pass until 2026-09-30,
// and is the parse's now, as the JVM's. The writer emits a call without arguments as a PropertyCall (0xdb),
// so the 0xdc bytes are given as the probe was given them.
describe('MethodCall: from v3, at least one argument (MethodCallSerializer.scala:52-56)', () => {
  it('T4-mc-empty-args-v3: proveDlog(Global.groupGenerator) through 0xdc without arguments rejects at parse (the JVM: AssertionError)', () => {
    // An output's tree is only parsed, never evaluated: the parse alone rejects it, with or without the box rules.
    expectRejected(parseBox(fromHex('0b06cddc6a01dd00')), ExprParseError, 'method-call-empty-args')
    // T4-mc-empty-args-v3-lenient (checkType = false): the JVM: AssertionError.
    expectRejected(parseBox(fromHex('0b06cddc6a01dd00'), false), ExprParseError, 'method-call-empty-args')
  })
  it('T4-mc-empty-args-v2 and -v0: the same call parses below v3 (the JVM: parsed)', () => {
    expectParsed(parseBox(fromHex('0a06cddc6a01dd00')))
    expectParsed(parseBox(fromHex('00cddc6a01dd00')))
  })
  it('T4-mc-propertycall-v3: the PropertyCall form (0xdb) parses (the JVM: parsed)', () => {
    expectParsed(parseBox(fromHex('0b05cddb6a01dd')))
  })
  it('T4-mc-one-arg-v3: a MethodCall with an argument parses, Global.some[Byte](0) (the JVM: parsed)', () => {
    const call: Expr = { tag: 'MethodCall', typeId: 106, methodId: 9, obj: { tag: 'Global' }, args: [BYTE0], explicitTypeArgs: { T: T.Byte } }
    const b = probed('T4-mc-one-arg-v3', sp(OptionIsDefined(call)), 0x0b, '0b0ad1e6dc6a09dd01020002')
    expectParsed(parseBox(b))
  })
  it('T4-mc-empty-args-v3-nested-dead: in a branch never evaluated it rejects too: the check is the parse (the JVM: AssertionError)', () => {
    expectRejected(parseBox(fromHex('0b11d195010093dc6a01dd00dc6a01dd000101')), ExprParseError, 'method-call-empty-args')
  })
  it('T4-mc-empty-args-v3-before-type-args: the assert comes before the explicit type arguments, none[T] then type byte 0x00 (the JVM: AssertionError)', () => {
    expectRejected(parseBox(fromHex('0b08d1e6dc6a0add0000')), ExprParseError, 'method-call-empty-args')
  })
  it('T4-mc-empty-args-v3-unknown-method: the assert comes before the method lookup, 106:200 (the JVM: AssertionError, not rule 1016)', () => {
    expectRejected(parseBox(fromHex('0b07d1e6dc6ac8dd00')), ExprParseError, 'method-call-empty-args')
  })
  it('T4-mc-empty-args-v2-root-groupelement-lenient: at v2 the call parses and evaluates to the generator (the JVM: parsed)', () => {
    const tree = parseParsedTree(fromHex('0a05dc6a01dd00'))
    expect(evaluate(tree)).toEqual({ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES })
  })
  it('the evaluator makes no arity check: the JVM makes it at parse only (MethodCallSerializer.scala:53-55)', () => {
    // A tree built through the API never passed the parse. The removed pre-eval pass rejected this one;
    // dispatchTreeBody now evaluates it, as the JVM's evaluator would the node.
    const tree: ErgoTree = {
      header: { version: 3, hasSize: true, constantSegregation: false, rawHeader: 0x0b },
      constantTypes: [],
      constants: [],
      body: { tag: 'MethodCall', typeId: 106, methodId: 1, obj: { tag: 'Global' }, args: [], explicitTypeArgs: {} },
    }
    expect(evaluate(tree)).toEqual({ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES })
  })
})

describe('ByIndex: before v3 the index is upcast to Int as it is read (ByIndexSerializer.scala:27-36)', () => {
  const at = (index: Expr, def: Expr | null = null): Expr => sp(EQ(ByIndex(collInt([1, 2]), index, def), int(1)))
  it('T4-byindex-v0-long-index: a Long index rejects (the JVM: AssertionError, SInt.max(SLong) is not SInt)', () => {
    const b = probed('T4-byindex-v0-long-index', at(long(0)), 0x00, '00d193b2100202040500000402')
    expectRejected(parseBox(b), ExprParseError, 'by-index-index-not-int')
  })
  it('T4b-byindex-v2-long-index: at v2 as well (the JVM: AssertionError)', () => {
    const b = probed('T4b-byindex-v2-long-index', at(long(0)), 0x0a, '0a0cd193b2100202040500000402')
    expectRejected(parseBox(b), ExprParseError, 'by-index-index-not-int')
  })
  it('T4-byindex-v3-long-index: from v3 the index is not checked (the JVM: parsed)', () => {
    const b = probed('T4-byindex-v3-long-index', at(long(0)), 0x0b, '0b0cd193b2100202040500000402')
    expectParsed(parseBox(b))
  })
  it('T4-byindex-v0-byte-index, T4b-byindex-v0-short-index, T4b-byindex-v0-int-index: a Byte, Short or Int index parses (the JVM: parsed)', () => {
    expectParsed(parseBox(probed('T4-byindex-v0-byte-index', at(BYTE0), 0x00, '00d193b2100202040200000402')))
    expectParsed(parseBox(probed('T4b-byindex-v0-short-index', at(SHORT0), 0x00, '00d193b2100202040300000402')))
    expectParsed(parseBox(probed('T4b-byindex-v0-int-index', at(int(0)), 0x00, '00d193b2100202040400000402')))
  })
  it('T4b-byindex-v0-bigint-index: a BigInt index rejects (the JVM: AssertionError)', () => {
    const b = probed('T4b-byindex-v0-bigint-index', at(BIGINT0), 0x00, '00d193b210020204060100000402')
    expectRejected(parseBox(b), ExprParseError, 'by-index-index-not-int')
  })
  it("T4b-byindex-v0-bool-, -sany-, -notype-index: an index that is not numeric rejects, the JVM's SAny and NoType included (the JVM: AssertionError)", () => {
    const cases: [string, Expr, string][] = [
      ['T4b-byindex-v0-bool-index', bool(true), '00d193b2100202040101000402'],
      ['T4b-byindex-v0-sany-index', BI, '00d193b210020204b2860204000400040000000402'],
      ['T4b-byindex-v0-notype-index', APPLY_NO, '00d193b210020204da0400010400000402'],
    ]
    for (const [name, index, h] of cases) {
      expectRejected(parseBox(probed(name, at(index), 0x00, h)), ExprParseError, 'by-index-index-not-int')
    }
  })
  it("T4-byindex-v0-ownsany-index: ergots parses an index typed as its own SAny, which the JVM rejects (AssertionError): residual 1", () => {
    // Plus(Int 1, CONTEXT.preHeader.timestamp) is a Long in the JVM; ergots cannot type 105:3.
    const b = probed('T4-byindex-v0-ownsany-index', at(Plus(int(1), TS)), 0x00, '00d193b2100202049a0402db6903db6503fe000402')
    expectParsed(parseBox(b))
  })
  it("T4b-byindex-order-long-index-then-overflow-default: the check comes before the default, whose read crosses the window (the JVM: AssertionError)", () => {
    const b = probed('T4b-byindex-order-long-index-then-overflow-default', at(long(0), OVERFLOW_INT), 0x08,
      `089b27d193b2100202040500019ab10e8827${RUN}04020402`)
    expectRejected(parseBox(b), ExprParseError, 'by-index-index-not-int')
  })
  it('T4b-byindex-order-control: with an Int index the default is read past the window and the tree degrades (the JVM: unparsed, rule 1014)', () => {
    const b = probed('T4b-byindex-order-control', at(int(0), OVERFLOW_INT), 0x08, `089b27d193b2100202040400019ab10e8827${RUN}04020402`)
    expectWindowDegrade(parseBox(b))
  })
})

describe('ExtractRegisterAs: the register id, right after its byte (ExtractRegisterAsSerializer.scala:25-31)', () => {
  const isDefined = (id: number, t: SType = T.Int): Expr => sp(OptionIsDefined(ERA(SELF, id, t)))
  it('T4-era-self-id-9 and T4b-era-self-id-0: R9 and R0 parse (the JVM: parsed)', () => {
    expectParsed(parseBox(probed('T4-era-self-id-9', isDefined(9), 0x00, '00d1e6c6a70904')))
    expectParsed(parseBox(probed('T4b-era-self-id-0', isDefined(0, T.Long), 0x00, '00d1e6c6a70005')))
  })
  it('T4-era-self-id-10, T4-era-self-id-0x80, T4b-era-self-id-0xff: an id outside 0..9, the signed byte, rejects (the JVM: NoSuchElementException)', () => {
    const cases: [string, number, string][] = [
      ['T4-era-self-id-10', 10, '00d1e6c6a70a04'],
      ['T4-era-self-id-0x80', -128, '00d1e6c6a78004'],
      ['T4b-era-self-id-0xff', -1, '00d1e6c6a7ff04'],
    ]
    for (const [name, id, h] of cases) {
      expectRejected(parseBox(probed(name, isDefined(id), 0x00, h)), ExprParseError, 'extract-register-as-id-out-of-range')
    }
  })
  it('T4-era-id-10-then-type-0x00: the id is checked before the type, whose byte 0x00 is invalid (the JVM: NoSuchElementException)', () => {
    expectRejected(parseBox(fromHex('00d1e6c6a70a00')), ExprParseError, 'extract-register-as-id-out-of-range')
  })
  it('T4b-era-id-10-then-unknown-type-sized: in a sized tree the id rejects before type code 108 (the JVM: NoSuchElementException, not the rule-1018 degrade)', () => {
    expectRejected(parseBox(fromHex('0806d1e6c6a70a6c')), ExprParseError, 'extract-register-as-id-out-of-range')
  })
})

describe('SelectField: the tuple cast, then the index (transformers.scala:294-295)', () => {
  // The writer refuses an index of 0, so those bytes are given as the probe was given them.
  it('T4-sf-index-0-over-tuple: an index of 0 over a tuple is out of range (the JVM: IndexOutOfBoundsException, index -1)', () => {
    expectRejected(parseBox(fromHex('00d1938c860204020404000402')), ExprTpeError, 'select-field-out-of-range')
  })
  it('T4-sf-index-0-over-int: over an Int the cast comes first, whatever the index (the JVM: ClassCastException)', () => {
    expectRejected(parseBox(fromHex('00d1938c0402000402')), ExprTpeError, 'select-field-input-not-stuple')
  })
  it('T4-sf-index-1-over-tuple-control: index 1 parses (the JVM: parsed)', () => {
    const b = probed('T4-sf-index-1-over-tuple-control', sp(EQ(SelectField(Tuple(int(1), int(2)), 1), int(1))), 0x00, '00d1938c860204020404010402')
    expectParsed(parseBox(b))
  })
  describe("over an input typed as ergots' own SAny, the parse passes an index of 1 to 127: residual 1", () => {
    // 99:6 (SELF.creationInfo) and 101:1 (CONTEXT.dataInputs) are not in ergots' catalog. The JVM knows
    // their types and rejects both trees at parse; ergots parses them and fails at eval.
    const box = { value: 1_000_000n, ergoTreeBytes: fromHex('0008d3'), registers: {}, tokens: [], creationHeight: 0, txId: new Uint8Array(32), index: 0 }
    it('T4c-sf-creationinfo-index-3: SelectField(SELF.creationInfo, 3) (the JVM: ArrayIndexOutOfBoundsException, index 2)', () => {
      const tree = parseParsedTree(fromHex('00d1938cdb6306a7030400'))
      expect(captureEvalError(() => evaluate(tree, { selfBox: box })).code).toBe('select-field-index-out-of-range')
    })
    it('T4c-sf-datainputs-index-1: SelectField(CONTEXT.dataInputs, 1) (the JVM: ClassCastException, a Coll is no STuple)', () => {
      const tree = parseParsedTree(fromHex('00d1938cdb6501fe010400'))
      expect(captureEvalError(() => evaluate(tree, { selfBox: box, dataInputs: [] })).code).toBe('select-field-input-not-tuple')
    })
  })
  describe('the index is a signed byte: over a 200-item tuple, 0x7f is item 127 and 0xc8 is -57', () => {
    const input = OptionGet(GetVar(1, T.Tuple(...new Array<SType>(200).fill(T.Int))))
    const tree = (i: number): Uint8Array => treeBytes(sp(EQ(SelectField(input, i), int(0))), 0x00)
    it('M2: index 0xc8 is out of range (the JVM: ArrayIndexOutOfBoundsException, index -57)', () => {
      expect(hex(tree(0xc8))).toBe(`00d1938ce4e30160c8${'04'.repeat(200)}c80400`)
      expectRejected(parseBox(tree(0xc8)), ExprTpeError, 'select-field-out-of-range')
    })
    it('M2b: index 0x7f parses (the JVM: parsed)', () => {
      expect(hex(tree(0x7f))).toBe(`00d1938ce4e30160c8${'04'.repeat(200)}7f0400`)
      expectParsed(parseBox(tree(0x7f)))
    })
  })
})

/**
 * Inside a script decoded at spend, a failure's JVM exception class decides the verdict: the substitution
 * swallows a ClassCastException and leaves the node, which a dead branch never evaluates, and any other
 * failure rejects the spend (Rewriter.scala:180-191; spec §5 item 2). Each tree declares the script's own
 * type in a dead branch, `sigmaProp(if (false) DC(1, t) == DC(1, t) else true)`, so a decode that succeeded
 * would substitute: only the decode decides. The verdicts are the probe's spend mode (variable 1 = the
 * script as a Coll[Byte]).
 */
describe("each check's JVM exception class, inside a script decoded at spend", () => {
  const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
  const deadDC = (t: SType, header: number): Uint8Array => treeBytes(dead(EQ(DC(1, t), DC(1, t))), header)
  const inVar1 = (b: Uint8Array): EvalOpts => ({
    extension: {
      values: new Map([[1, {
        tpe: T.Coll(T.Byte),
        value: { kind: 'Coll', elem: T.Byte, items: Array.from(b, (x) => ({ kind: 'Byte', value: (x << 24) >> 24 })) } as SValue,
      }]]),
    },
  })
  /** The spend rejects on the decode, dead as the node is: `deserialize-parse-failed`, with the check's error as its cause. */
  function expectDecodeReject(tree: Uint8Array, script: Uint8Array, code: string): void {
    const err = captureEvalError(() => evaluate(parseParsedTree(tree), inVar1(script)))
    expect(err.code).toBe('deserialize-parse-failed')
    expect((err.cause as { code?: string }).code).toBe(code)
    expect(isJvmClassCast(err.cause)).toBe(false)
  }

  it('T4s-dc-dead-v0-coll-item: the item assert is no class cast, so the spend rejects (the JVM: AssertionError)', () => {
    const tree = deadDC(T.Coll(T.Int), 0x00)
    const script = exprBytes(Coll(T.Int, [long(1)]))
    expect([hex(tree), hex(script)]).toEqual(['00d195010093d41001d410010101', '8301040502'])
    expectDecodeReject(tree, script, 'collection-item-type-mismatch')
  })
  it('T4s-dc-dead-v0-block-item: the BlockItem cast is a class cast, so the node stays in its dead branch (the JVM: TrueProp)', () => {
    const tree = deadDC(T.Int, 0x00)
    const script = exprBytes(Block([int(1)], int(2)))
    expect([hex(tree), hex(script)]).toEqual(['00d195010093d40401d404010101', 'd80104020404'])
    expect(evaluate(parseParsedTree(tree), inVar1(script))).toEqual(TRUE_PROP)
  })
  it('T4s-dc-dead-v3-mc-empty-args: the arity assert is no class cast, so the spend rejects (the JVM: AssertionError)', () => {
    // Coll(1, 2).indices (12:14) through 0xdc without arguments, decoded under the spent tree's version 3.
    const tree = deadDC(T.Coll(T.Int), 0x0b)
    expect(hex(tree)).toBe('0b0dd195010093d41001d410010101')
    expectDecodeReject(tree, fromHex('dc0c0e1002020400'), 'method-call-empty-args')
  })
  it('T4s-dc-dead-v2-mc-empty-args-control: under a v2 tree the same script decodes and substitutes (the JVM: TrueProp)', () => {
    const tree = deadDC(T.Coll(T.Int), 0x0a)
    expect(hex(tree)).toBe('0a0dd195010093d41001d410010101')
    expect(evaluate(parseParsedTree(tree), inVar1(fromHex('dc0c0e1002020400')))).toEqual(TRUE_PROP)
  })
  it('T4s-dc-dead-v0-byindex-long-index: the upcast assert is no class cast, so the spend rejects (the JVM: AssertionError)', () => {
    const tree = deadDC(T.Int, 0x00)
    const script = exprBytes(ByIndex(collInt([1, 2]), long(0)))
    expect(hex(script)).toBe('b210020204050000')
    expectDecodeReject(tree, script, 'by-index-index-not-int')
  })
  it('T4s-dc-dead-v0-era-id-10: the register lookup is no class cast, so the spend rejects (the JVM: NoSuchElementException)', () => {
    const tree = deadDC(T.Bool, 0x00)
    const script = exprBytes(OptionIsDefined(ERA(SELF, 10, T.Int)))
    expect([hex(tree), hex(script)]).toEqual(['00d195010093d40101d401010101', 'e6c6a70a04'])
    expectDecodeReject(tree, script, 'extract-register-as-id-out-of-range')
  })
  it('T4s-dc-dead-v0-sf-index-0-over-int: the tuple cast comes before the index, a class cast, so the node stays (the JVM: TrueProp)', () => {
    expect(evaluate(parseParsedTree(deadDC(T.Int, 0x00)), inVar1(fromHex('8c040200')))).toEqual(TRUE_PROP)
  })
  it('T4s-dc-dead-v0-sf-index-0-over-tuple: an index of 0 over a tuple is no class cast, so the spend rejects (the JVM: IndexOutOfBoundsException)', () => {
    expectDecodeReject(deadDC(T.Int, 0x00), fromHex('8c86020402040400'), 'select-field-out-of-range')
  })
})
