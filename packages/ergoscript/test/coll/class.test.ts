/**
 * Tests for the class part of the coll module: the class tag of an item type
 * (`arrayClassOf`), the data reader's class (`dataClass`), the runtime class of
 * a value (`runtimeClassOf`), and the lookup `classOf` that falls back to
 * `dataClass` when a value has no `cls`.
 *
 * JVM references at 6.0.7:
 *   core/shared/src/main/scala/sigma/Evaluation.scala:17-56         (stypeToRType)
 *   core/shared/src/main/scala/sigma/data/RType.scala               (class tags)
 *   core/shared/src/main/scala/sigma/serialization/CoreDataSerializer.scala:166-191
 *                                                                   (deserializeColl)
 *   core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:11, :205-215, :274
 *                                                                   (CollOverArray, fromBoxedPairs, PairOfCols)
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { Env } from '../../src/eval/env'
import { arrayClassOf, classOf, CollTypeRefused, dataClass, runtimeClassOf } from '../../src/coll'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SBYTE: SType = { tag: 'SByte' }
const SSHORT: SType = { tag: 'SShort' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBIGINT: SType = { tag: 'SBigInt' }
const SANY: SType = { tag: 'SAny' }
const SGROUPELEMENT: SType = { tag: 'SGroupElement' }
const SBOX: SType = { tag: 'SBox' }
const SSIGMAPROP: SType = { tag: 'SSigmaProp' }
const SOPTION_INT: SType = { tag: 'SOption', elem: SINT }
const SFUNC_INT_INT: SType = { tag: 'SFunc', args: [SINT], result: SINT, tpeParams: [] }

const collOf = (elem: SType): SType => ({ tag: 'SColl', elem })
const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })
const tupleOf = (...items: SType[]): SType => ({ tag: 'STuple', items })

describe('arrayClassOf (stypeToRType class tags, Evaluation.scala:17-56)', () => {
  it('returns primitive class tags for primitive item types', () => {
    expect(arrayClassOf(SBOOLEAN)).toBe('boolean')
    expect(arrayClassOf(SBYTE)).toBe('byte')
    expect(arrayClassOf(SSHORT)).toBe('short')
    expect(arrayClassOf(SINT)).toBe('int')
    expect(arrayClassOf(SLONG)).toBe('long')
  })

  it('returns Object for SAny (AnyType.classTag = ClassTag.Any)', () => {
    expect(arrayClassOf(SANY)).toBe('Object')
  })

  it('returns the reference class name for each reference item type', () => {
    expect(arrayClassOf(SBIGINT)).toBe('BigInt')
    expect(arrayClassOf({ tag: 'SUnsignedBigInt' })).toBe('UnsignedBigInt')
    expect(arrayClassOf(SGROUPELEMENT)).toBe('GroupElement')
    expect(arrayClassOf(SSIGMAPROP)).toBe('SigmaProp')
    expect(arrayClassOf(SBOX)).toBe('Box')
    expect(arrayClassOf({ tag: 'SAvlTree' })).toBe('AvlTree')
    expect(arrayClassOf({ tag: 'SHeader' })).toBe('Header')
    expect(arrayClassOf({ tag: 'SPreHeader' })).toBe('PreHeader')
    expect(arrayClassOf({ tag: 'SContext' })).toBe('Context')
    expect(arrayClassOf({ tag: 'SGlobal' })).toBe('Global')
    expect(arrayClassOf({ tag: 'SString' })).toBe('String')
    expect(arrayClassOf({ tag: 'SUnit' })).toBe('Unit')
  })

  it('returns Tuple2 for a pair type and Coll for a tuple of another arity', () => {
    expect(arrayClassOf(pairOf(SINT, SBYTE))).toBe('Tuple2')
    expect(arrayClassOf(tupleOf(SINT, SINT, SINT))).toBe('Coll')
    expect(arrayClassOf(tupleOf(SBYTE, SBYTE, SBYTE, SBYTE))).toBe('Coll')
  })

  it('returns Coll for every SColl element type', () => {
    expect(arrayClassOf(collOf(SBYTE))).toBe('Coll')
    expect(arrayClassOf(collOf(collOf(SINT)))).toBe('Coll')
  })

  it('returns Option for SOption', () => {
    expect(arrayClassOf(SOPTION_INT)).toBe('Option')
  })

  it('returns Function1 for a one-argument SFunc (funcRType, Evaluation.scala:52-54)', () => {
    expect(arrayClassOf(SFUNC_INT_INT)).toBe('Function1')
  })

  it('throws CollTypeRefused for a type stypeToRType refuses (SFunc of another arity, STypeVar)', () => {
    // Mirrors the JVM's `_ =>` arm of `stypeToRType` (Evaluation.scala:54-55 at 6.0.7).
    const tvCall = () => arrayClassOf({ tag: 'STypeVar', name: 'T' })
    expect(tvCall).toThrow(CollTypeRefused)
    expect(tvCall).toThrow(/STypeVar/)
    const fn0Call = () => arrayClassOf({ tag: 'SFunc', args: [], result: SINT, tpeParams: [] })
    expect(fn0Call).toThrow(CollTypeRefused)
    expect(fn0Call).toThrow(/SFunc/)
    const fn2Call = () => arrayClassOf({ tag: 'SFunc', args: [SINT, SINT], result: SINT, tpeParams: [] })
    expect(fn2Call).toThrow(CollTypeRefused)
    expect(fn2Call).toThrow(/SFunc/)
    // The error carries the refused type's tag.
    try { tvCall() } catch (e) {
      expect(e).toBeInstanceOf(CollTypeRefused)
      expect((e as CollTypeRefused).tag).toBe('STypeVar')
      expect((e as CollTypeRefused).name).toBe('CollTypeRefused')
    }
  })
})

describe('dataClass (CoreDataSerializer.deserializeColl :166-191)', () => {
  it('is specialised, primitive array for Coll[Boolean] and Coll[Byte] (:172, :174)', () => {
    expect(dataClass(SBYTE)).toEqual({ shape: 'array', specialised: true, array: 'byte' })
    expect(dataClass(SBOOLEAN)).toEqual({ shape: 'array', specialised: true, array: 'boolean' })
  })

  it('is plain, primitive array for the other primitive item types (:176-190)', () => {
    expect(dataClass(SINT)).toEqual({ shape: 'array', specialised: false, array: 'int' })
    expect(dataClass(SLONG)).toEqual({ shape: 'array', specialised: false, array: 'long' })
    expect(dataClass(SSHORT)).toEqual({ shape: 'array', specialised: false, array: 'short' })
  })

  it('is plain over Coll[] for Coll[Coll[T]]', () => {
    expect(dataClass(collOf(SBYTE))).toEqual({ shape: 'array', specialised: false, array: 'Coll' })
    expect(dataClass(collOf(collOf(SINT)))).toEqual({ shape: 'array', specialised: false, array: 'Coll' })
  })

  it('is pairs with plain sides for a pair item type (fromBoxedPairs :205-215)', () => {
    expect(dataClass(pairOf(SINT, SBYTE))).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'int' },
      rs: { shape: 'array', specialised: false, array: 'byte' },
    })
    expect(dataClass(pairOf(SBYTE, SBYTE))).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'byte' },
      rs: { shape: 'array', specialised: false, array: 'byte' },
    })
    expect(dataClass(pairOf(collOf(SINT), SBYTE))).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'Coll' },
      rs: { shape: 'array', specialised: false, array: 'byte' },
    })
  })

  it('is plain over Coll[] for a tuple of another arity (collRType(AnyType), :179-180)', () => {
    expect(dataClass(tupleOf(SINT, SINT, SINT))).toEqual({
      shape: 'array',
      specialised: false,
      array: 'Coll',
    })
    expect(dataClass(tupleOf(SBYTE, SBYTE, SBYTE, SBYTE))).toEqual({
      shape: 'array',
      specialised: false,
      array: 'Coll',
    })
  })

  it('is plain over the class tag for every other item type', () => {
    expect(dataClass(SBIGINT)).toEqual({ shape: 'array', specialised: false, array: 'BigInt' })
    expect(dataClass(SGROUPELEMENT)).toEqual({ shape: 'array', specialised: false, array: 'GroupElement' })
    expect(dataClass(SBOX)).toEqual({ shape: 'array', specialised: false, array: 'Box' })
    expect(dataClass(SOPTION_INT)).toEqual({ shape: 'array', specialised: false, array: 'Option' })
  })
})

describe('runtimeClassOf (the class of a value for an array store)', () => {
  it('maps each primitive kind to its primitive class', () => {
    expect(runtimeClassOf({ kind: 'Boolean', value: false })).toBe('boolean')
    expect(runtimeClassOf({ kind: 'Byte', value: 0 })).toBe('byte')
    expect(runtimeClassOf({ kind: 'Short', value: 0 })).toBe('short')
    expect(runtimeClassOf({ kind: 'Int', value: 0 })).toBe('int')
    expect(runtimeClassOf({ kind: 'Long', value: 0n })).toBe('long')
  })

  it('maps a two-item Tuple to Tuple2 and a Lambda to Function1', () => {
    const lam: SValue = {
      kind: 'Lambda',
      closure: {
        argIds: [1],
        argTpes: [SINT],
        body: { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: 0 } },
        capturedEnv: Env.empty(),
      },
    }
    expect(runtimeClassOf({ kind: 'Tuple', items: [{ kind: 'Int', value: 0 }, { kind: 'Int', value: 0 }] })).toBe('Tuple2')
    expect(runtimeClassOf(lam)).toBe('Function1')
  })

  it('maps each reference kind to its reference class', () => {
    expect(runtimeClassOf({ kind: 'BigInt', value: 0n })).toBe('BigInt')
    expect(runtimeClassOf({ kind: 'UnsignedBigInt', value: 0n })).toBe('UnsignedBigInt')
    expect(runtimeClassOf({ kind: 'GroupElement', value: new Uint8Array(33) })).toBe('GroupElement')
    expect(runtimeClassOf({ kind: 'Unit' })).toBe('Unit')
    expect(runtimeClassOf({ kind: 'String', value: '' })).toBe('String')
    expect(runtimeClassOf({ kind: 'Coll', elem: SBYTE, items: [] })).toBe('Coll')
    expect(runtimeClassOf({ kind: 'Option', elem: SINT, value: null })).toBe('Option')
    expect(runtimeClassOf({ kind: 'Context' })).toBe('Context')
    expect(runtimeClassOf({ kind: 'Global' })).toBe('Global')
  })

  it('throws for a Tuple of another arity than two', () => {
    expect(() =>
      runtimeClassOf({
        kind: 'Tuple',
        items: [{ kind: 'Int', value: 0 }, { kind: 'Int', value: 0 }, { kind: 'Int', value: 0 }],
      }),
    ).toThrow(/Tuple/)
  })
})

describe('classOf (v.cls, or dataClass(v.elem) when absent)', () => {
  it('reads cls when it is present', () => {
    const cls = { shape: 'array', specialised: true, array: 'int' } as const
    expect(classOf({ kind: 'Coll', elem: SINT, items: [], cls })).toBe(cls)
  })

  it('falls back to the data reader when cls is absent', () => {
    expect(classOf({ kind: 'Coll', elem: SBYTE, items: [] })).toEqual(dataClass(SBYTE))
    expect(classOf({ kind: 'Coll', elem: SINT, items: [] })).toEqual(dataClass(SINT))
    expect(classOf({ kind: 'Coll', elem: pairOf(SINT, SBYTE), items: [] })).toEqual(dataClass(pairOf(SINT, SBYTE)))
  })

  it('resolves a Coll[Coll[Byte]] literal with no cls at both depths (review focus 1)', () => {
    const inner: SValue = { kind: 'Coll', elem: SBYTE, items: [{ kind: 'Byte', value: 1 }] }
    const outer: SValue = { kind: 'Coll', elem: collOf(SBYTE), items: [inner] }
    expect(classOf(outer)).toEqual({ shape: 'array', specialised: false, array: 'Coll' })
    const innerOnly = outer.items[0]! as SValue & { kind: 'Coll' }
    expect(classOf(innerOnly)).toEqual({ shape: 'array', specialised: true, array: 'byte' })
  })
})
