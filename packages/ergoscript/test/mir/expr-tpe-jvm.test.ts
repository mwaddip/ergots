// exprTpe as the JVM's `tpe` read (sigma-state 6.0.6; spec 2026-09-30 §1): version-aware, memoized
// per node and version class, NoType for an Apply of anything but a function or a collection, the
// collection cast for Filter, Slice and Append, the JVM's signed SelectField index, and the type a
// method call was built with.
//
// Where a comment cites "the probe", the verdict is a local sigma-state 6.0.6 probe's, in tree mode
// with checkType = true on the bytes given. Most probed trees put the node under test in a
// collection literal, `sigmaProp(Coll[T](e).size == 1)`, whose item assert (`v.tpe == tItem`,
// ConcreteCollectionSerializer.scala:35-39) shows the JVM's type for e.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { exprTpe, ExprTpeError, recordCallType, recordedCallType } from '../../src/mir/expr-tpe'
import { isOwnSAny } from '../../src/mir/jvm-types'
import { NOTYPE_JVM, SANY_JVM, isUnparsedTree } from '../../src/mir/types'
import type { Expr, SType } from '../../src/mir/types'
import { parseTree } from '../../src/wire/ergo-tree'
import {
  Append, Apply, BI, BitOr, Block, ByIndex, Coll, Ctx, DC, DR, EQ, Filter, GetVar, If, MC, OptionGet, PC, Plus,
  SelectField, SigmaAnd, SizeOf, Slice, T, Tuple, Upcast, ValDef, bin, bool, bytes, collInt, hex, int, lambdaTrue,
  long, sp, treeBytes, Negation,
} from '../_helpers/mir-build'

const codeOf = (f: () => unknown): string | undefined => {
  try {
    f()
  } catch (e) {
    return (e as { code?: string }).code
  }
  return undefined
}
/** The tree a probe case parsed: `sigmaProp(Coll[t](e).size == 1)`. */
const inColl = (t: SType, e: Expr): Expr => sp(EQ(SizeOf(Coll(t, [e])), int(1)))
/** `{ val v1 = e; sigmaProp(true) }`: the ValDef reads e's type (ValDefSerializer.scala:47-49). */
const inVal = (e: Expr): Expr => Block([ValDef(1, e)], sp(bool(true)))
/** CONTEXT.preHeader.timestamp: the JVM's Long, ergots' own SAny (neither 101:3 nor 105:3 is in its catalog). */
const TS = PC(105, 3, PC(101, 3, Ctx))
/** Apply(Int 0, [Int 0]): the JVM's NoType. */
const APPLY_NO = Apply(int(0), [int(0)])
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }

describe('arithmetic before v3: the builder upcasts to the wider operand (SigmaBuilder.scala:674-683, 707-712)', () => {
  it('Plus(Int 1, Long 2) is SLong at v0 and SInt at v3', () => {
    // The probe: Coll[Long](Plus(Int 1, Long 2)) parses at v0 and fails the item assert at v3
    // (AssertionError): the JVM types it Long before v3 and Int, its left operand's, from v3.
    expect(hex(treeBytes(inColl(T.Long, Plus(int(1), long(2))), 0x00))).toBe('00d193b18301059a040205040402')
    expect(hex(treeBytes(inColl(T.Long, Plus(int(1), long(2))), 0x0b))).toBe('0b0dd193b18301059a040205040402')
    expect(exprTpe(Plus(int(1), long(2)), 0)).toEqual(SLONG)
    expect(exprTpe(Plus(int(1), long(2)), 3)).toEqual(SINT)
  })
  it('Plus(Long 2, Int 1) is SLong at both versions', () => {
    // The probe: Coll[Long](Plus(Long 2, Int 1)) parses at v0 and at v3.
    expect(hex(treeBytes(inColl(T.Long, Plus(long(2), int(1))), 0x00))).toBe('00d193b18301059a050404020402')
    expect(exprTpe(Plus(long(2), int(1)), 0)).toEqual(SLONG)
    expect(exprTpe(Plus(long(2), int(1)), 3)).toEqual(SLONG)
  })
  it('every arithmetic op widens, and only arithmetic', () => {
    for (const op of ['Plus', 'Minus', 'Multiply', 'Divide', 'Modulo', 'Min', 'Max'] as const) {
      const e = bin({ kind: 'Arith', op }, int(1), long(2))
      expect(exprTpe(e, 0)).toEqual(SLONG)
      expect(exprTpe(e, 3)).toEqual(SINT)
    }
  })
  it('the wider type is the larger numericTypeIndex (Byte 0 … UnsignedBigInt 5)', () => {
    const c = (tag: SType['tag'], value: object): Expr => ({ tag: 'Const', tpe: { tag } as SType, value } as Expr)
    const byte = c('SByte', { kind: 'Byte', value: 1 })
    const short = c('SShort', { kind: 'Short', value: 1 })
    const big = c('SBigInt', { kind: 'BigInt', value: 1n })
    expect(exprTpe(Plus(byte, short), 0)).toEqual({ tag: 'SShort' })
    expect(exprTpe(Plus(short, byte), 0)).toEqual({ tag: 'SShort' })
    expect(exprTpe(Plus(big, long(1)), 0)).toEqual({ tag: 'SBigInt' })
    expect(exprTpe(Plus(long(1), big), 0)).toEqual({ tag: 'SBigInt' })
  })
  it('versions 1 and 2 widen as 0 does; versions 4 to 7 read the left operand as 3 does', () => {
    const e = Plus(int(1), long(2))
    for (const v of [1, 2]) expect(exprTpe(e, v)).toEqual(SLONG)
    for (const v of [4, 5, 6, 7]) expect(exprTpe(e, v)).toEqual(SINT)
  })
  it("Plus(Int 1, CONTEXT.preHeader.timestamp) at v0 is ergots' own SAny (review M4)", () => {
    // The probe: Coll[Long](Plus(Int 1, timestamp)) parses (00d193b18301059a0402db6903db6503fe0402)
    // and Coll[Int](the same) fails the item assert: the JVM types it Long, the wider operand's type.
    // ergots cannot type the timestamp (residual 1), so it cannot know the wider type either.
    expect(hex(treeBytes(inColl(T.Long, Plus(int(1), TS)), 0x00))).toBe('00d193b18301059a0402db6903db6503fe0402')
    const t = exprTpe(Plus(int(1), TS), 0)
    expect(isOwnSAny(t)).toBe(true)
    expect(exprTpe(Plus(int(1), TS), 3)).toEqual(SINT)
  })
  it('a left operand that is not numeric keeps its type, whatever the right one', () => {
    // applyUpcast upcasts only when both types are numeric (SigmaBuilder.scala:675-676), so a
    // non-numeric left operand leaves ArithOp.tpe = left.tpe even beside an operand ergots cannot
    // type. The probe, at v0: Coll[Any](Plus(ByIndex(tuple), timestamp)) parses and Coll[Long](the
    // same) fails the item assert, so the JVM types it as its SAny; Coll[Any](Plus(Apply(Int 0, [0]),
    // timestamp)) fails the item assert and Negation of it parses, so the JVM types that one NoType.
    expect(hex(treeBytes(inColl(T.Any, Plus(BI, TS)), 0x00))).toBe('00d193b18301619ab2860204000400040000db6903db6503fe0402')
    expect(hex(treeBytes(inColl(T.Any, Plus(APPLY_NO, TS)), 0x00))).toBe('00d193b18301619ada0400010400db6903db6503fe0402')
    expect(exprTpe(Plus(BI, TS), 0)).toBe(SANY_JVM)
    expect(exprTpe(Plus(APPLY_NO, TS), 0)).toBe(NOTYPE_JVM)
    expect(exprTpe(Plus(bool(true), TS), 0)).toEqual({ tag: 'SBoolean' })
    // An own-SAny left operand is unknown, whatever the right one.
    expect(isOwnSAny(exprTpe(Plus(TS, long(1)), 0))).toBe(true)
    expect(isOwnSAny(exprTpe(Plus(TS, BI), 0))).toBe(true)
  })
  it('a root Plus(ByIndex(tuple), timestamp) fails rule 1001 as the JVM SAny', () => {
    // The probe: unsized, rejected (SerializerException: a ValidationException of rule 1001 in a
    // tree without the size bit); sized, Unparsed by rule 1001.
    const body = Plus(BI, TS)
    const unsized = treeBytes(body, 0x00)
    expect(hex(unsized)).toBe('009ab2860204000400040000db6903db6503fe')
    let err: unknown
    try {
      parseTree(unsized, { checkType: true })
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'soft-fork-without-size-bit' })
    expect((err as Error).cause).toMatchObject({ code: 'root-not-sigma-prop' })
    const sized = parseTree(treeBytes(body, 0x08), { checkType: true })
    expect(isUnparsedTree(sized)).toBe(true)
    if (isUnparsedTree(sized)) expect(sized.error).toMatchObject({ code: 'root-not-sigma-prop' })
  })
  it('from v3 the right operand is not read', () => {
    expect(exprTpe(Plus(int(1), Filter(BI)), 3)).toEqual(SINT)
    expect(codeOf(() => exprTpe(Plus(int(1), Filter(BI)), 0))).toBe('filter-input-class-cast')
  })
  it('BitOr(Int, Long) is SInt at v0: BitOp has no upcast', () => {
    // mkBitOr builds BitOp directly (SigmaBuilder.scala:637-638). The probe: Coll[Int](BitOr(Int 1,
    // Long 2)) parses at v0, and Coll[Long](the same) fails the item assert.
    expect(hex(treeBytes(inColl(T.Int, BitOr(int(1), long(2))), 0x00))).toBe('00d193b1830104f2040205040402')
    expect(exprTpe(BitOr(int(1), long(2)), 0)).toEqual(SINT)
    expect(exprTpe(BitOr(int(1), long(2)), 3)).toEqual(SINT)
  })
})

describe('Apply.tpe: an SFunc range, a collection element, else NoType (values.scala:1247-1251)', () => {
  it('Apply(Int 0, [Int 0]) is NOTYPE_JVM', () => {
    // The probe: a ValDef bound to Negation(Apply(Int 0, [0])) parses (NoType passes isNumTypeOrNoType),
    // and Coll[Any](Apply(Int 0, [0])) fails the item assert (NoType != SAny).
    expect(hex(treeBytes(inVal(Negation(APPLY_NO)), 0x00))).toBe('00d801d601f0da0400010400d10101')
    expect(hex(treeBytes(inColl(T.Any, APPLY_NO), 0x00))).toBe('00d193b1830161da04000104000402')
    expect(exprTpe(APPLY_NO, 0)).toBe(NOTYPE_JVM)
    expect(exprTpe(APPLY_NO, 3)).toBe(NOTYPE_JVM)
  })
  it('an STuple-typed function gives NOTYPE_JVM: STuple is no SCollectionType (SType.scala:766, 838)', () => {
    // The probe: Negation(Apply(Tuple(0, 0), [0])) in a ValDef parses; Coll[Any](Apply(Tuple(0, 0), [0]))
    // fails the item assert.
    const e = Apply(Tuple(int(0), int(0)), [int(0)])
    expect(hex(treeBytes(inVal(Negation(e)), 0x00))).toBe('00d801d601f0da860204000400010400d10101')
    expect(exprTpe(e, 0)).toBe(NOTYPE_JVM)
  })
  it("the JVM's SAny as a function (Apply(ByIndex(tuple), [0])) gives NOTYPE_JVM", () => {
    // test/wire/rule-1001-jvm-sany-arms.test.ts: the probe parses Negation(Apply(ByIndex(tuple), [0]))
    // in a ValDef.
    expect(exprTpe(Apply(BI, [int(0)]), 0)).toBe(NOTYPE_JVM)
    expect(exprTpe(Apply(APPLY_NO, [int(0)]), 0)).toBe(NOTYPE_JVM)
  })
  it("ergots' own SAny as a function gives that SAny", () => {
    const f = PC(12, 200, collInt([1]))
    const ft = exprTpe(f, 3)
    expect(isOwnSAny(ft)).toBe(true)
    expect(exprTpe(Apply(f, [int(0)]), 3)).toBe(ft)
  })
  it('an SFunc function gives its range; a collection its element', () => {
    expect(exprTpe(Apply(lambdaTrue, [int(0)]), 0)).toEqual({ tag: 'SBoolean' })
    expect(exprTpe(Apply(collInt([1]), [int(0)]), 0)).toEqual(SINT)
  })
})

describe('Filter, Slice, Append: the input type is cast to SCollection (transformers.scala:121, 89, 62)', () => {
  const ARMS: [string, (x: Expr) => Expr, string][] = [
    ['Filter', (x) => Filter(x), 'filter'],
    ['Slice', (x) => Slice(x, int(0), int(1)), 'slice'],
    ['Append', (x) => Append(x, x), 'append'],
  ]
  it('the probe: over an Int, each is a ClassCastException; over a tuple, each types as the tuple', () => {
    // SInt$ cannot be cast to SCollection: a ValDef bound to each rejects. STuple extends SCollection,
    // and Coll[(Int, Int)](each over Tuple(0, 0)) parses, so the node types as the tuple.
    expect(hex(treeBytes(inVal(Filter(int(1))), 0x00))).toBe('00d801d601b50402d90101040101d10101')
    expect(hex(treeBytes(inVal(Slice(int(1), int(0), int(1))), 0x00))).toBe('00d801d601b4040204000402d10101')
    expect(hex(treeBytes(inVal(Append(int(1), int(1))), 0x00))).toBe('00d801d601b304020402d10101')
    const t0 = Tuple(int(0), int(0))
    const tt = T.Tuple(T.Int, T.Int)
    expect(hex(treeBytes(inColl(tt, Filter(t0)), 0x00))).toBe('00d193b1830158b5860204000400d901010401010402')
    expect(hex(treeBytes(inColl(tt, Slice(t0, int(0), int(1))), 0x00))).toBe('00d193b1830158b4860204000400040004020402')
    expect(hex(treeBytes(inColl(tt, Append(t0, t0)), 0x00))).toBe('00d193b1830158b38602040004008602040004000402')
  })
  for (const [arm, build, prefix] of ARMS) {
    it(`${arm} over Int 1 throws ExprTpeError '${prefix}-input-not-scoll'`, () => {
      let err: unknown
      try {
        exprTpe(build(int(1)), 0)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ExprTpeError)
      expect((err as ExprTpeError).code).toBe(`${prefix}-input-not-scoll`)
      expect(codeOf(() => exprTpe(build(bool(true)), 3))).toBe(`${prefix}-input-not-scoll`)
    })
    it(`${arm} over a tuple types as the tuple`, () => {
      const t0 = Tuple(int(0), long(0))
      expect(exprTpe(build(t0), 0)).toEqual(T.Tuple(T.Int, T.Long))
    })
    it(`${arm} over the JVM SAny keeps its class-cast code`, () => {
      expect(codeOf(() => exprTpe(build(BI), 0))).toBe(`${prefix}-input-class-cast`)
      expect(codeOf(() => exprTpe(build(APPLY_NO), 0))).toBe(`${prefix}-input-class-cast`)
    })
    it(`${arm} over a collection or ergots' own SAny types as it`, () => {
      expect(exprTpe(build(collInt([1])), 0)).toEqual(T.Coll(T.Int))
      const own = PC(12, 200, collInt([1]))
      expect(exprTpe(build(own), 0)).toBe(exprTpe(own, 0))
    })
  }
})

describe("SelectField: the JVM's signed Byte index (SelectFieldSerializer.scala:22, transformers.scala:294)", () => {
  // OptionGet(GetVar(1, (Int × 200))): a 200-item tuple, so the index, not the arity, decides.
  const input = OptionGet(GetVar(1, T.Tuple(...new Array<SType>(200).fill(T.Int))))
  it('index 0x7f selects item 127', () => {
    // The probe: sigmaProp(SelectField(input, 0x7f) == 0) parses.
    expect(exprTpe(SelectField(input, 0x7f), 0)).toEqual(SINT)
  })
  it('indices 0x80, 0xc8 and 0 are out of range', () => {
    // The probe: 0x80, 0xc8 and 0 each reject with ArrayIndexOutOfBoundsException (index -129, -57, -1).
    for (const i of [0x80, 0xc8, 0x00]) {
      expect(codeOf(() => exprTpe(SelectField(input, i), 0))).toBe('select-field-out-of-range')
    }
  })
  it('an index past the arity is out of range; an input that is no tuple is a cast first', () => {
    expect(codeOf(() => exprTpe(SelectField(Tuple(int(0), int(0)), 3), 0))).toBe('select-field-out-of-range')
    expect(codeOf(() => exprTpe(SelectField(int(0), 0), 0))).toBe('select-field-input-not-stuple')
    expect(codeOf(() => exprTpe(SelectField(BI, 0), 0))).toBe('select-field-input-class-cast')
  })
})

describe('memoization per node and version class', () => {
  it('a repeated read returns the same object', () => {
    // A Tuple's type is built on each computation, so identity shows the second read was not one.
    const x = Tuple(int(1), long(2))
    const first = exprTpe(x, 0)
    expect(first).toEqual(T.Tuple(T.Int, T.Long))
    expect(exprTpe(x, 0)).toBe(first)
    expect(exprTpe(x, 1)).toBe(first)
  })
  it('a repeated read does not re-enter the children', () => {
    let reads = 0
    const child = new Proxy(int(1), {
      get(target, prop, receiver) {
        reads++
        return Reflect.get(target, prop, receiver)
      },
    }) as Expr
    const x = Tuple(child, long(2))
    const first = exprTpe(x, 3)
    const after = reads
    expect(after).toBeGreaterThan(0)
    expect(exprTpe(x, 3)).toBe(first)
    expect(reads).toBe(after)
  })
  it('the two version classes are kept apart', () => {
    const x = Plus(int(1), long(2))
    expect(exprTpe(x, 0)).toEqual(SLONG)
    expect(exprTpe(x, 3)).toEqual(SINT)
    expect(exprTpe(x, 0)).toEqual(SLONG)
  })
  it('a failure is cached: the same error object again, also for a parent', () => {
    const f = Filter(int(1))
    const errOf = (x: Expr): unknown => {
      try {
        exprTpe(x, 0)
      } catch (e) {
        return e
      }
      return undefined
    }
    const e1 = errOf(f)
    expect(e1).toBeInstanceOf(ExprTpeError)
    expect(errOf(f)).toBe(e1)
    expect(errOf(Tuple(f, int(0)))).toBe(e1)
  })
})

describe('the recorded call type (values.scala:1355: a MethodCall is typed when it is built)', () => {
  const OPTION_INT: SType = { tag: 'SOption', elem: SINT }
  it('without a record, a call resolves through the catalog', () => {
    const mc = MC(12, 33, collInt([1]), [int(0)]) // Coll.get: Option[IV]
    expect(recordedCallType(mc)).toBeUndefined()
    expect(exprTpe(mc, 3)).toEqual(OPTION_INT)
  })
  it('with a record, exprTpe returns it whatever the children say', () => {
    const mc = MC(12, 33, collInt([1]), [int(0)])
    const rec: SType = { tag: 'SInt' }
    recordCallType(mc, rec)
    expect(recordedCallType(mc)).toBe(rec)
    expect(exprTpe(mc, 3)).toBe(rec)
    expect(exprTpe(mc, 0)).toBe(rec)
  })
  it('the record is read before any child', () => {
    // Without a record the object's type is read, and Filter over the JVM's SAny throws.
    expect(codeOf(() => exprTpe(MC(12, 33, Filter(BI), [int(0)]), 3))).toBe('filter-input-class-cast')
    const mc = MC(12, 33, Filter(BI), [int(0)])
    recordCallType(mc, OPTION_INT)
    expect(exprTpe(mc, 3)).toBe(OPTION_INT)
  })
  it('a record wins over an earlier read of the node', () => {
    const mc = MC(12, 33, collInt([1]), [int(0)])
    expect(exprTpe(mc, 3)).toEqual(OPTION_INT)
    const rec: SType = { tag: 'SLong' }
    recordCallType(mc, rec)
    expect(exprTpe(mc, 3)).toBe(rec)
  })
  it('a PropertyCall takes its record the same way', () => {
    const pc = PC(12, 200, Filter(BI)) // uncatalogued: ergots' own SAny, nothing read
    expect(isOwnSAny(exprTpe(pc, 3))).toBe(true)
    const pc2 = PC(12, 200, Filter(BI))
    const rec: SType = { tag: 'SInt' }
    recordCallType(pc2, rec)
    expect(exprTpe(pc2, 3)).toBe(rec)
  })
})

// exprTpe must be total over the Expr union (spec 2026-09-30, the Scope's gates): its reads run at
// every node built and at every eval-time type read, so a variant with no arm would reject honest
// trees. One well-formed instance per tag, with every sub-kind of BinOp, Collection and GlobalVars.
type ByTag = { [K in Expr['tag']]: Extract<Expr, { tag: K }>[] }
const SELF: Expr = { tag: 'GlobalVars', kind: 'SelfBox' }
const GEN: Expr = { tag: 'GlobalVars', kind: 'GroupGenerator' }
const SP_TRUE = sp(bool(true))
const BOOLS = Coll(T.Bool, [bool(true)])
const BYTES = bytes([1, 2, 3])
const VU_INT: Expr = { tag: 'ValUse', valId: 1, tpe: SINT }
const PAIR = T.Tuple(T.Int, T.Int)
const WELL_FORMED: ByTag = {
  Append: [Append(collInt([1]), collInt([2]))],
  Const: [int(0)],
  ConstPlaceholder: [{ tag: 'ConstPlaceholder', id: 0, tpe: SINT }],
  SubstConstants: [{ tag: 'SubstConstants', scriptBytes: BYTES, positions: collInt([0]), newValues: Coll(T.Int, [int(1)]) }],
  ByteArrayToLong: [{ tag: 'ByteArrayToLong', input: bytes(new Array(8).fill(0)) }],
  ByteArrayToBigInt: [{ tag: 'ByteArrayToBigInt', input: BYTES }],
  LongToByteArray: [{ tag: 'LongToByteArray', input: long(1) }],
  Collection: [Coll(T.Int, [int(1)]), { tag: 'Collection', kind: 'BoolConstants', items: [true, false] }],
  Tuple: [Tuple(int(1), bool(true))],
  CalcBlake2b256: [{ tag: 'CalcBlake2b256', input: BYTES }],
  CalcSha256: [{ tag: 'CalcSha256', input: BYTES }],
  Context: [Ctx],
  Global: [{ tag: 'Global' }],
  GlobalVars: (['Height', 'Inputs', 'Outputs', 'SelfBox', 'MinerPubKey', 'GroupGenerator'] as const).map(
    (kind) => ({ tag: 'GlobalVars', kind }) as const,
  ),
  LastBlockUtxoRootHash: [{ tag: 'LastBlockUtxoRootHash' }],
  FuncValue: [lambdaTrue],
  Apply: [Apply(lambdaTrue, [int(0)])],
  MethodCall: [MC(12, 33, collInt([1]), [int(0)]), MC(12, 200, collInt([1]), [int(0)])],
  PropertyCall: [PC(12, 14, collInt([1])), PC(101, 1, Ctx)],
  BlockValue: [Block([ValDef(1, int(0))], VU_INT)],
  ValDef: [ValDef(1, int(0))],
  ValUse: [{ tag: 'ValUse', valId: 1, tpe: SINT }],
  If: [If(bool(true), int(1), int(2))],
  BinOp: [
    Plus(int(1), int(2)),
    EQ(int(1), int(1)),
    bin({ kind: 'Logical', op: 'And' }, bool(true), bool(false)),
    BitOr(int(1), int(2)),
  ],
  And: [{ tag: 'And', input: BOOLS }],
  Or: [{ tag: 'Or', input: BOOLS }],
  Xor: [{ tag: 'Xor', left: BYTES, right: BYTES }],
  Atleast: [{ tag: 'Atleast', bound: int(1), input: Coll(T.SigmaProp, [SP_TRUE]) }],
  LogicalNot: [{ tag: 'LogicalNot', input: bool(true) }],
  Negation: [Negation(int(1))],
  BitInversion: [{ tag: 'BitInversion', input: int(1) }],
  OptionGet: [OptionGet(GetVar(1, SINT))],
  OptionIsDefined: [{ tag: 'OptionIsDefined', input: GetVar(1, SINT) }],
  OptionGetOrElse: [{ tag: 'OptionGetOrElse', input: GetVar(1, SINT), default: int(0) }],
  ExtractAmount: [{ tag: 'ExtractAmount', input: SELF }],
  ExtractRegisterAs: [{ tag: 'ExtractRegisterAs', input: SELF, registerId: 4, elemTpe: SINT }],
  ExtractBytes: [{ tag: 'ExtractBytes', input: SELF }],
  ExtractBytesWithNoRef: [{ tag: 'ExtractBytesWithNoRef', input: SELF }],
  ExtractScriptBytes: [{ tag: 'ExtractScriptBytes', input: SELF }],
  ExtractCreationInfo: [{ tag: 'ExtractCreationInfo', input: SELF }],
  ExtractId: [{ tag: 'ExtractId', input: SELF }],
  ByIndex: [ByIndex(collInt([1]), int(0)), ByIndex(collInt([1]), int(0), int(7))],
  SizeOf: [SizeOf(collInt([1]))],
  Slice: [Slice(collInt([1, 2]), int(0), int(1))],
  Fold: [{
    tag: 'Fold',
    input: collInt([1]),
    zero: int(0),
    foldOp: { tag: 'FuncValue', args: [{ id: 1, tpe: PAIR }], body: SelectField({ tag: 'ValUse', valId: 1, tpe: PAIR }, 1) },
  }],
  Map: [{ tag: 'Map', input: collInt([1]), mapper: { tag: 'FuncValue', args: [{ id: 1, tpe: SINT }], body: VU_INT } }],
  Filter: [Filter(collInt([1]))],
  Exists: [{ tag: 'Exists', input: collInt([1]), condition: lambdaTrue }],
  ForAll: [{ tag: 'ForAll', input: collInt([1]), condition: lambdaTrue }],
  SelectField: [SelectField(Tuple(int(0), bool(true)), 2)],
  BoolToSigmaProp: [SP_TRUE],
  Upcast: [Upcast(int(1), SLONG)],
  Downcast: [{ tag: 'Downcast', input: long(1), tpe: SINT }],
  CreateProveDlog: [{ tag: 'CreateProveDlog', input: GEN }],
  CreateProveDhTuple: [{ tag: 'CreateProveDhTuple', g: GEN, h: GEN, u: GEN, v: GEN }],
  SigmaPropBytes: [{ tag: 'SigmaPropBytes', input: SP_TRUE }],
  SigmaPropIsProven: [{ tag: 'SigmaPropIsProven', input: SP_TRUE }],
  ZkProofBlock: [{ tag: 'ZkProofBlock', input: SP_TRUE }],
  DecodePoint: [{ tag: 'DecodePoint', input: bytes(new Array(33).fill(2)) }],
  SigmaAnd: [SigmaAnd(SP_TRUE, SP_TRUE)],
  SigmaOr: [{ tag: 'SigmaOr', items: [SP_TRUE, SP_TRUE] }],
  GetVar: [GetVar(1, SINT)],
  DeserializeRegister: [DR(4, SINT), DR(4, SINT, int(0))],
  DeserializeContext: [DC(1, SINT)],
  MultiplyGroup: [{ tag: 'MultiplyGroup', left: GEN, right: GEN }],
  Exponentiate: [{ tag: 'Exponentiate', left: GEN, right: { tag: 'Const', tpe: { tag: 'SBigInt' }, value: { kind: 'BigInt', value: 3n } } }],
  XorOf: [{ tag: 'XorOf', input: BOOLS }],
  TreeLookup: [{ tag: 'TreeLookup', tree: { tag: 'LastBlockUtxoRootHash' }, key: BYTES, proof: BYTES }],
  CreateAvlTree: [{
    tag: 'CreateAvlTree',
    flags: { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 0 } },
    digest: bytes(new Array(33).fill(0)),
    keyLength: int(32),
    valueLength: { tag: 'Const', tpe: T.Option(T.Int), value: { kind: 'Option', elem: T.Int, value: null } },
  }],
}

describe('exprTpe is total over the Expr union', () => {
  it('the instances cover exactly the members of the Expr union in mir/types.ts', () => {
    // The union's members are the interfaces named after their tags.
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(path.join(here, '../../src/mir/types.ts'), 'utf8')
    const union = /export type Expr =([\s\S]*?)\n\n/.exec(src)?.[1] ?? ''
    const members = [...union.matchAll(/\|\s*([A-Za-z0-9]+)/g)].map((m) => m[1]).sort()
    expect(members.length).toBeGreaterThan(0)
    expect(Object.keys(WELL_FORMED).sort()).toEqual(members)
  })
  for (const [tag, instances] of Object.entries(WELL_FORMED) as [string, Expr[]][]) {
    instances.forEach((x, i) => {
      for (const v of [0, 3]) {
        it(`${tag} #${i} at v${v} has a type`, () => {
          expect(x.tag).toBe(tag)
          let t: SType | undefined
          expect(() => {
            t = exprTpe(x, v)
          }).not.toThrow()
          expect(typeof t?.tag).toBe('string')
        })
      }
    })
  }
})
