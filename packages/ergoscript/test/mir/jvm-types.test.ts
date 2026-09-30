// The JVM's type equality, numeric tests and ClassCastException codes (sigma-state 6.0.6).
//
// Type equality in the JVM is Scala `==`: structural for its case classes (SCollectionType, SOption,
// STuple, SFunc, STypeVar) and identity for its case objects, so `NoType != SAny`
// (core/.../sigma/ast/SType.scala:278, 626). ergots models the JVM's SAny and NoType as the frozen
// objects SANY_JVM and NOTYPE_JVM; any other `{ tag: 'SAny' }` is ergots' own, a type its method
// typing could not resolve, which the parse-time checks treat as unknown (residual 1).
import { describe, it, expect } from 'vitest'
import { ReaderError } from '@ergots/scorex'
import {
  isJvmNumeric,
  isOwnSAny,
  jvmTypeEquals,
  numericTypeIndex,
  scriptTypeEquals,
} from '../../src/mir/jvm-types'
import { isJvmClassCast, JVM_CLASS_CAST_CODES } from '../../src/wire/jvm-exceptions'
import { ExprTpeError } from '../../src/mir/expr-tpe'
import { ExprParseError } from '../../src/wire/errors'
import { NOTYPE_JVM, SANY_JVM } from '../../src/mir/types'
import type { SType } from '../../src/mir/types'

const I: SType = { tag: 'SInt' }
const L: SType = { tag: 'SLong' }
const own = (): SType => ({ tag: 'SAny' })
const coll = (elem: SType): SType => ({ tag: 'SColl', elem })
const opt = (elem: SType): SType => ({ tag: 'SOption', elem })
const tuple = (...items: SType[]): SType => ({ tag: 'STuple', items })
const func = (args: SType[], result: SType, tpeParams: string[] = []): SType =>
  ({ tag: 'SFunc', args, result, tpeParams: tpeParams.map((name) => ({ name })) })

describe('isOwnSAny', () => {
  it("is true for a fresh { tag: 'SAny' } only", () => {
    expect(isOwnSAny(own())).toBe(true)
    expect(isOwnSAny(SANY_JVM)).toBe(false)
    expect(isOwnSAny(NOTYPE_JVM)).toBe(false)
    expect(isOwnSAny(I)).toBe(false)
    expect(isOwnSAny(coll(own()))).toBe(false)
  })
})

describe('isJvmNumeric, numericTypeIndex: the JVM SNumericType order (SType.scala:412-556)', () => {
  const ORDER: [SType['tag'], number][] = [
    ['SByte', 0], ['SShort', 1], ['SInt', 2], ['SLong', 3], ['SBigInt', 4], ['SUnsignedBigInt', 5],
  ]
  for (const [tag, index] of ORDER) {
    it(`${tag} is numeric, index ${index}`, () => {
      const t = { tag } as SType
      expect(isJvmNumeric(t)).toBe(true)
      expect(numericTypeIndex(t)).toBe(index)
    })
  }
  it('no other type is numeric, and numericTypeIndex throws for one', () => {
    for (const t of [{ tag: 'SBoolean' }, SANY_JVM, NOTYPE_JVM, own(), coll(I), tuple(I, I), opt(I)] as SType[]) {
      expect(isJvmNumeric(t)).toBe(false)
      expect(() => numericTypeIndex(t)).toThrow()
    }
  })
})

describe('jvmTypeEquals: the JVM == for the parse-time checks', () => {
  it('is structural', () => {
    expect(jvmTypeEquals(I, { tag: 'SInt' })).toBe(true)
    expect(jvmTypeEquals(I, L)).toBe(false)
    expect(jvmTypeEquals(coll(I), coll(I))).toBe(true)
    expect(jvmTypeEquals(coll(I), coll(L))).toBe(false)
    expect(jvmTypeEquals(opt(coll(I)), opt(coll(I)))).toBe(true)
    expect(jvmTypeEquals(coll(I), opt(I))).toBe(false)
    expect(jvmTypeEquals(func([I], L), func([I], L))).toBe(true)
    expect(jvmTypeEquals(func([I], L), func([L], L))).toBe(false)
    expect(jvmTypeEquals(func([I], L), func([I], L, ['T']))).toBe(false)
    expect(jvmTypeEquals({ tag: 'STypeVar', name: 'T' }, { tag: 'STypeVar', name: 'T' })).toBe(true)
    expect(jvmTypeEquals({ tag: 'STypeVar', name: 'T' }, { tag: 'STypeVar', name: 'U' })).toBe(false)
  })
  it('STuple([Int, Long]) vs STuple([Int, Int]) is false', () => {
    expect(jvmTypeEquals(tuple(I, L), tuple(I, I))).toBe(false)
    expect(jvmTypeEquals(tuple(I, L), tuple(I, L))).toBe(true)
    expect(jvmTypeEquals(tuple(I, L), tuple(I, L, I))).toBe(false)
  })
  it('NOTYPE_JVM equals only itself: NoType != SAny', () => {
    expect(jvmTypeEquals(NOTYPE_JVM, SANY_JVM)).toBe(false)
    expect(jvmTypeEquals(SANY_JVM, NOTYPE_JVM)).toBe(false)
    expect(jvmTypeEquals(NOTYPE_JVM, NOTYPE_JVM)).toBe(true)
    expect(jvmTypeEquals(NOTYPE_JVM, I)).toBe(false)
  })
  it('SANY_JVM equals only itself, also nested', () => {
    expect(jvmTypeEquals(SANY_JVM, SANY_JVM)).toBe(true)
    expect(jvmTypeEquals(coll(SANY_JVM), coll(SANY_JVM))).toBe(true)
    expect(jvmTypeEquals(SANY_JVM, I)).toBe(false)
    expect(jvmTypeEquals(coll(SANY_JVM), coll(NOTYPE_JVM))).toBe(false)
  })
  it("ergots' own SAny is unknown, against the JVM's SAny too", () => {
    expect(jvmTypeEquals(SANY_JVM, own())).toBe('unknown')
    expect(jvmTypeEquals(own(), SANY_JVM)).toBe('unknown')
    expect(jvmTypeEquals(own(), I)).toBe('unknown')
    expect(jvmTypeEquals(own(), own())).toBe('unknown')
    expect(jvmTypeEquals(NOTYPE_JVM, own())).toBe('unknown')
  })
  it("SColl(SInt) vs SColl(own SAny) is unknown", () => {
    expect(jvmTypeEquals(coll(I), coll(own()))).toBe('unknown')
  })
  it('a known difference beside an unknown leaf is false', () => {
    expect(jvmTypeEquals(tuple(own(), L), tuple(I, I))).toBe(false)
    expect(jvmTypeEquals(tuple(I, own()), tuple(L, I))).toBe(false)
    expect(jvmTypeEquals(tuple(I, own()), tuple(I, I))).toBe('unknown')
    expect(jvmTypeEquals(func([own()], L), func([I], I))).toBe(false)
  })
})

describe("scriptTypeEquals: sTypeEquals, with the JVM's NoType != SAny", () => {
  it('NOTYPE_JVM vs a declared SAny is false', () => {
    expect(scriptTypeEquals(NOTYPE_JVM, SANY_JVM)).toBe(false)
    expect(scriptTypeEquals(SANY_JVM, NOTYPE_JVM)).toBe(false)
    expect(scriptTypeEquals(NOTYPE_JVM, own())).toBe(false)
    expect(scriptTypeEquals(NOTYPE_JVM, NOTYPE_JVM)).toBe(true)
  })
  it('STuple([NOTYPE_JVM]) vs STuple([SAny]) is false: the NoType leaf at depth', () => {
    expect(scriptTypeEquals(tuple(NOTYPE_JVM), tuple(SANY_JVM))).toBe(false)
    expect(scriptTypeEquals(coll(opt(NOTYPE_JVM)), coll(opt(own())))).toBe(false)
    expect(scriptTypeEquals(tuple(NOTYPE_JVM), tuple(NOTYPE_JVM))).toBe(true)
  })
  it("own SAny vs SAny is true, own SAny vs SInt false: master's structural equality", () => {
    expect(scriptTypeEquals(own(), SANY_JVM)).toBe(true)
    expect(scriptTypeEquals(SANY_JVM, own())).toBe(true)
    expect(scriptTypeEquals(own(), I)).toBe(false)
    expect(scriptTypeEquals(coll(own()), coll(I))).toBe(false)
  })
  it('is structural otherwise', () => {
    expect(scriptTypeEquals(tuple(I, L), tuple(I, L))).toBe(true)
    expect(scriptTypeEquals(tuple(I, L), tuple(I, I))).toBe(false)
    expect(scriptTypeEquals(func([I], coll(L)), func([I], coll(L)))).toBe(true)
  })
})

// The JVM's ClassCastException codes: the casts on its parse path (spec 2026-09-30 §2, the
// facts' "isJvmClassCast"). Kiama's `strategy` swallows exactly this class (Rewriter.scala:180-191).
const TPE_CODES = [
  'by-index-input-class-cast', 'by-index-input-not-scoll',
  'option-get-input-class-cast', 'option-get-input-not-soption',
  'option-get-or-else-input-class-cast', 'option-get-or-else-input-not-soption',
  'select-field-input-class-cast', 'select-field-input-not-stuple',
  'map-mapper-class-cast', 'map-mapper-not-sfunc',
  'filter-input-class-cast', 'filter-input-not-scoll',
  'slice-input-class-cast', 'slice-input-not-scoll',
  'append-input-class-cast', 'append-input-not-scoll',
]
const PARSE_CODES = ['numeric-cast-target-not-numeric', 'block-value-item-not-val-def', 'fun-def-tpe-arg-not-type-var']

describe('isJvmClassCast', () => {
  it('JVM_CLASS_CAST_CODES holds the 19 codes', () => {
    expect([...JVM_CLASS_CAST_CODES].sort()).toEqual([...TPE_CODES, ...PARSE_CODES].sort())
  })
  for (const code of TPE_CODES) {
    it(`an ExprTpeError '${code}' is a class cast; an ExprParseError with that code is not`, () => {
      expect(isJvmClassCast(new ExprTpeError('x', code))).toBe(true)
      expect(isJvmClassCast(new ExprParseError('x', code))).toBe(false)
    })
  }
  for (const code of PARSE_CODES) {
    it(`an ExprParseError '${code}' is a class cast; an ExprTpeError with that code is not`, () => {
      expect(isJvmClassCast(new ExprParseError('x', code))).toBe(true)
      expect(isJvmClassCast(new ExprTpeError('x', code))).toBe(false)
    })
  }
  it('another code or another class is not', () => {
    // select-field-out-of-range: the JVM's IndexOutOfBoundsException after the tuple cast.
    expect(isJvmClassCast(new ExprTpeError('x', 'select-field-out-of-range'))).toBe(false)
    // numeric-cast-input-not-numeric: the Upcast/Downcast require's IllegalArgumentException.
    expect(isJvmClassCast(new ExprParseError('x', 'numeric-cast-input-not-numeric'))).toBe(false)
    expect(isJvmClassCast(new ReaderError('x', 'truncated'))).toBe(false)
    expect(isJvmClassCast(new Error('by-index-input-class-cast'))).toBe(false)
    expect(isJvmClassCast(undefined)).toBe(false)
  })
})
