import { describe, expect, it } from 'vitest'
import { numericV6Handlers } from '../../src/eval/_numeric-v6'

describe('numeric v6 coverage', () => {
  it('registers all 48 (type, method) handlers', () => {
    const hs = numericV6Handlers()
    expect(hs.length).toBe(48)
    const keys = new Set(hs.map((h) => `${h.typeId}:${h.methodId}`))
    // Byte=2, Short=3, Int=4, Long=5, BigInt=6, UnsignedBigInt=9
    for (const typeId of [2, 3, 4, 5, 6, 9]) {
      for (const methodId of [6, 7, 8, 9, 10, 11, 12, 13]) {
        expect(keys.has(`${typeId}:${methodId}`)).toBe(true)
      }
    }
  })
})
