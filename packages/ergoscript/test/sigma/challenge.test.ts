import { describe, it, expect } from 'vitest'
import { challengeXor, CHALLENGE_BYTES } from '../../src/sigma/challenge'

function makeChallenge(fillByte: number): Uint8Array {
  return new Uint8Array(CHALLENGE_BYTES).fill(fillByte)
}

describe('challenge primitives', () => {
  it('CHALLENGE_BYTES === 24', () => {
    expect(CHALLENGE_BYTES).toBe(24)
  })

  describe('challengeXor', () => {
    it('XOR of all-zeros and x = x', () => {
      const zeros = makeChallenge(0)
      const ones = makeChallenge(0xff)
      const result = challengeXor(zeros, ones)
      for (let i = 0; i < CHALLENGE_BYTES; i++) expect(result[i]).toBe(0xff)
    })

    it('XOR of x and x = zeros', () => {
      const x = makeChallenge(0xa5)
      const result = challengeXor(x, x)
      for (let i = 0; i < CHALLENGE_BYTES; i++) expect(result[i]).toBe(0)
    })

    it('is commutative', () => {
      const a = new Uint8Array(CHALLENGE_BYTES)
      const b = new Uint8Array(CHALLENGE_BYTES)
      for (let i = 0; i < CHALLENGE_BYTES; i++) { a[i] = i; b[i] = (i * 3 + 7) % 256 }
      const ab = challengeXor(a, b)
      const ba = challengeXor(b, a)
      for (let i = 0; i < CHALLENGE_BYTES; i++) expect(ab[i]).toBe(ba[i])
    })

    it('throws on length mismatch', () => {
      expect(() => challengeXor(new Uint8Array(24), new Uint8Array(23))).toThrow()
      expect(() => challengeXor(new Uint8Array(23), new Uint8Array(24))).toThrow()
    })
  })
})
