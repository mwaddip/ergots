import { describe, it, expect } from 'vitest'
import { sTypeEquals, isPrimitive } from '../src/mir/stype-helpers'
import type { SType } from '../src/mir/types'

describe('SType helpers', () => {
  it('detects primitive types', () => {
    const cases: [SType, boolean][] = [
      [{ tag: 'SBoolean' }, true],
      [{ tag: 'SInt' }, true],
      [{ tag: 'SLong' }, true],
      [{ tag: 'SBigInt' }, true],
      [{ tag: 'SGroupElement' }, true],
      [{ tag: 'SColl', elem: { tag: 'SInt' } }, false],
      [{ tag: 'SOption', elem: { tag: 'SInt' } }, false],
      [{ tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SLong' }] }, false]
    ]
    for (const [t, expected] of cases) {
      expect(isPrimitive(t)).toBe(expected)
    }
  })

  it('equates structurally identical types', () => {
    const a: SType = { tag: 'SColl', elem: { tag: 'SInt' } }
    const b: SType = { tag: 'SColl', elem: { tag: 'SInt' } }
    expect(sTypeEquals(a, b)).toBe(true)

    const c: SType = { tag: 'SColl', elem: { tag: 'SLong' } }
    expect(sTypeEquals(a, c)).toBe(false)
  })

  it('equates nested types', () => {
    const a: SType = { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }
    const b: SType = { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }
    expect(sTypeEquals(a, b)).toBe(true)
  })

  it('equates tuples by item order + types', () => {
    const a: SType = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] }
    const b: SType = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] }
    const c: SType = { tag: 'STuple', items: [{ tag: 'SBoolean' }, { tag: 'SInt' }] }
    expect(sTypeEquals(a, b)).toBe(true)
    expect(sTypeEquals(a, c)).toBe(false)
  })

  it('equates SFunc by args + result + tpeParams', () => {
    const a: SType = { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SBoolean' }, tpeParams: [] }
    const b: SType = { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SBoolean' }, tpeParams: [] }
    expect(sTypeEquals(a, b)).toBe(true)

    // Different args
    const c: SType = { tag: 'SFunc', args: [{ tag: 'SLong' }], result: { tag: 'SBoolean' }, tpeParams: [] }
    expect(sTypeEquals(a, c)).toBe(false)

    // Different result
    const d: SType = { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SLong' }, tpeParams: [] }
    expect(sTypeEquals(a, d)).toBe(false)

    // Different arg arity
    const e: SType = { tag: 'SFunc', args: [{ tag: 'SInt' }, { tag: 'SInt' }], result: { tag: 'SBoolean' }, tpeParams: [] }
    expect(sTypeEquals(a, e)).toBe(false)
  })

  it('equates SFunc by tpeParams names', () => {
    const a: SType = {
      tag: 'SFunc',
      args: [{ tag: 'STypeVar', name: 'T' }],
      result: { tag: 'STypeVar', name: 'T' },
      tpeParams: [{ name: 'T' }]
    }
    const b: SType = {
      tag: 'SFunc',
      args: [{ tag: 'STypeVar', name: 'T' }],
      result: { tag: 'STypeVar', name: 'T' },
      tpeParams: [{ name: 'T' }]
    }
    expect(sTypeEquals(a, b)).toBe(true)

    // Different tpeParams names
    const c: SType = {
      tag: 'SFunc',
      args: [{ tag: 'STypeVar', name: 'T' }],
      result: { tag: 'STypeVar', name: 'T' },
      tpeParams: [{ name: 'U' }]
    }
    expect(sTypeEquals(a, c)).toBe(false)
  })

  it('equates STypeVar by name', () => {
    expect(sTypeEquals({ tag: 'STypeVar', name: 'T' }, { tag: 'STypeVar', name: 'T' })).toBe(true)
    expect(sTypeEquals({ tag: 'STypeVar', name: 'T' }, { tag: 'STypeVar', name: 'U' })).toBe(false)
  })
})
