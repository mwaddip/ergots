import { describe, it, expect } from 'vitest'
import type { SType } from '@ergots/ergoscript'
import { stypeFromSanta, stypeToSanta } from '../src/stype'
import type { Json } from '../src/json'

describe('SType bridge', () => {
  const cases: Array<[{ [k: string]: Json }, SType]> = [
    [{ tag: 'SBoolean' }, { tag: 'SBoolean' }],
    [{ tag: 'SInt' }, { tag: 'SInt' }],
    [{ tag: 'SLong' }, { tag: 'SLong' }],
    [{ tag: 'SBigInt' }, { tag: 'SBigInt' }],
    [{ tag: 'SGroupElement' }, { tag: 'SGroupElement' }],
    [{ tag: 'SBox' }, { tag: 'SBox' }],
    [{ tag: 'SAvlTree' }, { tag: 'SAvlTree' }],
    [{ tag: 'SColl', elem: { tag: 'SInt' } }, { tag: 'SColl', elem: { tag: 'SInt' } }],
    [{ tag: 'SOption', elem: { tag: 'SLong' } }, { tag: 'SOption', elem: { tag: 'SLong' } }],
    [
      { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] },
      { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] },
    ],
  ]

  for (const [santa, ergots] of cases) {
    it(`${JSON.stringify(santa)} ⇄ ergots SType`, () => {
      expect(stypeFromSanta(santa)).toEqual(ergots)
      expect(stypeToSanta(ergots)).toEqual(santa)
    })
  }

  it('SUnsignedBigInt ⇄ ergots leaf (bridged since ergots shipped UBI)', () => {
    expect(stypeFromSanta({ tag: 'SUnsignedBigInt' })).toEqual({ tag: 'SUnsignedBigInt' })
    expect(stypeToSanta({ tag: 'SUnsignedBigInt' } as SType)).toEqual({ tag: 'SUnsignedBigInt' })
  })

  it('nested SColl[SUnsignedBigInt] maps through', () => {
    expect(stypeFromSanta({ tag: 'SColl', elem: { tag: 'SUnsignedBigInt' } }))
      .toEqual({ tag: 'SColl', elem: { tag: 'SUnsignedBigInt' } })
  })
})
