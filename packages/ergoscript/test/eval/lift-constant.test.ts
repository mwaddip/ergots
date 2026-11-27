/**
 * The lift of a runtime value to the type of the constant the JVM makes of it
 * (`Platform.liftToConstant`, data/jvm/src/main/scala/sigma/Platform.scala:16-63, sigma-state 6.0.7).
 * `null` is the JVM's `Nullable.None`: the value has no lift.
 */
import { describe, it, expect } from 'vitest'
import { liftToConstantType } from '../../src/eval/_lift-constant'
import { tupleColl } from '../../src/coll/build'
import { SANY_JVM } from '../../src/mir/types'
import type { SType, SValue } from '../../src/mir/types'

const payload = {} as never

const ALWAYS: [SValue, SType][] = [
  [{ kind: 'Boolean', value: true }, { tag: 'SBoolean' }],
  [{ kind: 'Byte', value: 1 }, { tag: 'SByte' }],
  [{ kind: 'Short', value: 1 }, { tag: 'SShort' }],
  [{ kind: 'Int', value: 1 }, { tag: 'SInt' }],
  [{ kind: 'Long', value: 1n }, { tag: 'SLong' }],
  [{ kind: 'BigInt', value: 1n }, { tag: 'SBigInt' }],
  [{ kind: 'GroupElement', value: new Uint8Array(33) }, { tag: 'SGroupElement' }],
  [{ kind: 'SigmaProp', value: payload }, { tag: 'SSigmaProp' }],
  [{ kind: 'AvlTree', value: payload }, { tag: 'SAvlTree' }],
  [{ kind: 'Coll', elem: { tag: 'SInt' }, items: [] }, { tag: 'SColl', elem: { tag: 'SInt' } }],
]

const NEVER: SValue[] = [
  { kind: 'Unit' },
  { kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }] },
  { kind: 'Option', elem: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
  { kind: 'Option', elem: { tag: 'SInt' }, value: null },
  { kind: 'Context' },
  { kind: 'Global' },
  { kind: 'Lambda', closure: payload },
]

describe('liftToConstantType: a value with a lift at every version', () => {
  for (const [value, tpe] of ALWAYS) {
    for (const treeVersion of [0, 3]) {
      it(`${value.kind} at tree version ${treeVersion}`, () => {
        expect(liftToConstantType(value, treeVersion)).toEqual(tpe)
      })
    }
  }

  it('a tuple of three is a collection of the JVM Any', () => {
    const t = tupleColl([{ kind: 'Int', value: 1 }, { kind: 'Long', value: 2n }, { kind: 'Int', value: 3 }])
    const lifted = liftToConstantType(t, 0)
    expect(lifted).toEqual({ tag: 'SColl', elem: SANY_JVM })
    expect((lifted as { tag: 'SColl'; elem: SType }).elem).toBe(SANY_JVM)
  })
})

describe('liftToConstantType: a value with no lift at any version', () => {
  for (const value of NEVER) {
    for (const treeVersion of [0, 3]) {
      it(`${value.kind}${value.kind === 'Option' ? (value.value === null ? ' (None)' : ' (Some)') : ''} at tree version ${treeVersion}`, () => {
        expect(liftToConstantType(value, treeVersion)).toBeNull()
      })
    }
  }
})

describe('liftToConstantType: a Box lifts at every activated version', () => {
  const box: SValue = { kind: 'Box', value: payload }
  for (const treeVersion of [0, 1, 2, 3]) {
    it(`tree version ${treeVersion}: SBox`, () => {
      expect(liftToConstantType(box, treeVersion)).toEqual({ tag: 'SBox' })
    })
  }
})

describe('liftToConstantType: Header, PreHeader and UnsignedBigInt lift from tree version 3 (Platform.scala:34-36)', () => {
  const V3_ONLY: [SValue, SType][] = [
    [{ kind: 'Header', value: payload }, { tag: 'SHeader' }],
    [{ kind: 'PreHeader', value: payload }, { tag: 'SPreHeader' }],
    [{ kind: 'UnsignedBigInt', value: 1n }, { tag: 'SUnsignedBigInt' }],
  ]
  for (const [value, tpe] of V3_ONLY) {
    it(`${value.kind} at tree version 2: no lift`, () => {
      expect(liftToConstantType(value, 2)).toBeNull()
    })
    it(`${value.kind} at tree version 3: ${tpe.tag}`, () => {
      expect(liftToConstantType(value, 3)).toEqual(tpe)
    })
  }
})

describe('liftToConstantType: a String lifts below tree version 3 (Platform.scala:38)', () => {
  const s: SValue = { kind: 'String', value: 'A' }
  it('tree version 2: SString', () => {
    expect(liftToConstantType(s, 2)).toEqual({ tag: 'SString' })
  })
  it('tree version 3: no lift', () => {
    expect(liftToConstantType(s, 3)).toBeNull()
  })
})

describe('liftToConstantType: every kind of value is answered', () => {
  const KINDS = {
    Boolean: true, Byte: true, Short: true, Int: true, Long: true, BigInt: true, UnsignedBigInt: true,
    GroupElement: true, SigmaProp: true, Box: true, PreHeader: true, Header: true, AvlTree: true, Unit: true,
    Context: true, Global: true, Coll: true, Tuple: true, Option: true, Lambda: true, String: true,
  } satisfies Record<SValue['kind'], true>

  for (const kind of Object.keys(KINDS)) {
    it(`${kind} is lifted or refused without a throw`, () => {
      const v = { kind, value: payload, elem: { tag: 'SInt' }, items: [], closure: payload } as unknown as SValue
      const lifted = liftToConstantType(v, 3)
      expect(lifted === null || typeof lifted.tag === 'string').toBe(true)
    })
  }
})
