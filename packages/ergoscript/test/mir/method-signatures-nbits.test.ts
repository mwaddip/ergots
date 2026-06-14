import { describe, expect, it } from 'vitest'
import { methodSignature } from '../../src/mir/method-signatures'

describe('method-signatures: nbits (v6 P5b-2)', () => {
  it('106:6 encodeNbits = (SGlobal, SBigInt) -> SLong, closed tRange, no tpeParams', () => {
    expect(methodSignature(106, 6)).toEqual({
      tDom: [{ tag: 'SGlobal' }, { tag: 'SBigInt' }],
      tRange: { tag: 'SLong' },
    })
  })
  it('106:7 decodeNbits = (SGlobal, SLong) -> SBigInt, closed tRange, no tpeParams', () => {
    expect(methodSignature(106, 7)).toEqual({
      tDom: [{ tag: 'SGlobal' }, { tag: 'SLong' }],
      tRange: { tag: 'SBigInt' },
    })
  })
})
