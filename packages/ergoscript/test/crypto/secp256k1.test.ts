import { describe, it, expect } from 'vitest'
import {
  decodePoint, encodePoint, pointAdd, pointNegate, pointMul,
  basePoint, groupOrder, scalarFromBytes, scalarFromChallenge,
} from '../../src/crypto/secp256k1'

const ZERO_33 = new Uint8Array(33)  // Ergo identity

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('secp256k1 adapter', () => {
  describe('identity convention (33 zero bytes ↔ point-at-infinity)', () => {
    it('decodePoint(33 zeros) returns identity', () => {
      const identity = decodePoint(ZERO_33)
      // Add identity to basePoint, should equal basePoint
      const sum = pointAdd(basePoint, identity)
      expect(bytesEqual(encodePoint(sum), encodePoint(basePoint))).toBe(true)
    })

    it('encodePoint(identity) returns 33 zero bytes', () => {
      const identity = decodePoint(ZERO_33)
      const encoded = encodePoint(identity)
      expect(bytesEqual(encoded, ZERO_33)).toBe(true)
    })
  })

  describe('basePoint encoding', () => {
    it('encodePoint(basePoint) is 33 bytes starting with 0x02 or 0x03', () => {
      const bytes = encodePoint(basePoint)
      expect(bytes.length).toBe(33)
      expect([0x02, 0x03]).toContain(bytes[0])
    })

    it('encodePoint(basePoint) round-trips through decodePoint', () => {
      const bytes = encodePoint(basePoint)
      const decoded = decodePoint(bytes)
      const reEncoded = encodePoint(decoded)
      expect(bytesEqual(reEncoded, bytes)).toBe(true)
    })
  })

  describe('groupOrder', () => {
    it('matches secp256k1 n', () => {
      // n = FFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFE_BAAEDCE6_AF48A03B_BFD25E8C_D0364141
      expect(groupOrder).toBe(
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n
      )
    })
  })

  describe('scalarFromBytes (32 BE → mod n)', () => {
    it('decodes 32-byte big-endian scalar', () => {
      const bytes = new Uint8Array(32)
      bytes[31] = 5
      expect(scalarFromBytes(bytes)).toBe(5n)
    })

    it('reduces values ≥ n', () => {
      // n + 1 in big-endian
      const nPlus1Hex = (groupOrder + 1n).toString(16).padStart(64, '0')
      const bytes = new Uint8Array(32)
      for (let i = 0; i < 32; i++) bytes[i] = parseInt(nPlus1Hex.slice(i*2, i*2+2), 16)
      expect(scalarFromBytes(bytes)).toBe(1n)
    })
  })

  describe('scalarFromChallenge (24 bytes → left-pad 8 zeros → mod n)', () => {
    it('left-pads with 8 zero bytes before reduction', () => {
      const challenge = new Uint8Array(24)
      challenge[23] = 7
      // 24-byte value 7 → left-padded becomes 32-byte BE value 7
      expect(scalarFromChallenge(challenge)).toBe(7n)
    })

    it('all-zero challenge → scalar 0', () => {
      expect(scalarFromChallenge(new Uint8Array(24))).toBe(0n)
    })

    it('max 24-byte value fits comfortably in 32 bytes after left-pad', () => {
      const challenge = new Uint8Array(24).fill(0xff)
      const expected = (1n << 192n) - 1n
      expect(scalarFromChallenge(challenge)).toBe(expected)
    })
  })

  describe('point ops', () => {
    it('pointMul(basePoint, 1) === basePoint', () => {
      const result = pointMul(basePoint, 1n)
      expect(bytesEqual(encodePoint(result), encodePoint(basePoint))).toBe(true)
    })

    it('pointMul(basePoint, 0) === identity', () => {
      const result = pointMul(basePoint, 0n)
      expect(bytesEqual(encodePoint(result), ZERO_33)).toBe(true)
    })

    it('pointMul(basePoint, n) === identity', () => {
      const result = pointMul(basePoint, groupOrder)
      expect(bytesEqual(encodePoint(result), ZERO_33)).toBe(true)
    })

    it('pointAdd(p, negate(p)) === identity', () => {
      const p2 = pointMul(basePoint, 12345n)
      const negP2 = pointNegate(p2)
      const sum = pointAdd(p2, negP2)
      expect(bytesEqual(encodePoint(sum), ZERO_33)).toBe(true)
    })
  })

  describe('decodePoint rejects off-curve bytes', () => {
    it('throws on invalid SEC1 tag', () => {
      const bytes = new Uint8Array(33)
      bytes[0] = 0xff  // invalid tag (not 0x02, 0x03, or 0x00)
      expect(() => decodePoint(bytes)).toThrow()
    })

    it('throws on wrong length', () => {
      expect(() => decodePoint(new Uint8Array(32))).toThrow()
      expect(() => decodePoint(new Uint8Array(34))).toThrow()
    })
  })
})
