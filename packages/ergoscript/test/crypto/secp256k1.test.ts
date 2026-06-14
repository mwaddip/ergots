import { describe, it, expect } from 'vitest'
import {
  decodePoint, encodePoint, pointAdd, pointNegate, pointMul,
  basePoint, groupOrder, scalarFromBytes, scalarFromChallenge,
  expPoint,
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

  // secp256k1 generator G, SEC1-compressed (same constant used by expUnsigned handler tests).
  const G_HEX = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  function hexToBytes(hex: string): Uint8Array {
    return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
  }
  const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

  describe('expPoint', () => {
    it('identity base, any k → 33 zero bytes', () => {
      // identity^k = identity regardless of k; mirrors the sigma-rust short-circuit.
      const result = expPoint(ZERO_33, 5n)
      expect(bytesEqual(result, ZERO_33)).toBe(true)
    })

    it('G with k=0 → 33 zero bytes (identity)', () => {
      // pointMul guards k=0 → ZERO; encodePoint(ZERO) → 33 zero bytes.
      const result = expPoint(hexToBytes(G_HEX), 0n)
      expect(bytesEqual(result, ZERO_33)).toBe(true)
    })

    it('G with k=1 → G (round-trip)', () => {
      // g^1 = g; the JVM blessed vector from LanguageSpecificationV6.scala:2475.
      const gBytes = hexToBytes(G_HEX)
      const result = expPoint(gBytes, 1n)
      expect(bytesEqual(result, gBytes)).toBe(true)
    })

    it('g^(n+1) = g — pins mod-n reduction for k > n (first wire-reachable above-order surface)', () => {
      // A UBI scalar in [n, 2^256) is valid wire input; mod-n must reduce it correctly.
      const gBytes = hexToBytes(G_HEX)
      const result = expPoint(gBytes, ORDER + 1n)
      expect(bytesEqual(result, gBytes)).toBe(true)
    })

    it('g^(2^256 - 1) = g^((2^256-1) mod n) — reduction-equivalence pin (full 256-bit scalar)', () => {
      // The maximum UBI value; confirms expPoint applies mod-n before pointMul.
      const gBytes = hexToBytes(G_HEX)
      const kMax = (1n << 256n) - 1n
      const out = expPoint(gBytes, kMax)
      expect(out).toBeInstanceOf(Uint8Array)
      expect(out.length).toBe(33)
      // Reduction-equivalence: expPoint(G, k) must equal expPoint(G, k mod n).
      const reduced = expPoint(gBytes, kMax % ORDER)
      expect(bytesEqual(out, reduced)).toBe(true)
    })
  })

  describe('decodePoint rejects off-curve bytes', () => {
    it('throws on invalid SEC1 tag', () => {
      const bytes = new Uint8Array(33)
      bytes[0] = 0xff  // invalid tag (not 0x02, 0x03, or 0x00)
      expect(() => decodePoint(bytes)).toThrow()
    })

    it('throws on fewer than 33 bytes (mirrors read_exact)', () => {
      expect(() => decodePoint(new Uint8Array(32))).toThrow()
      expect(() => decodePoint(new Uint8Array(0))).toThrow()
    })

    // iter-24 (mainnet h=1,111,884): sigma-rust `EcPoint::scorex_parse` reads
    // EXACTLY the first 33 bytes (read_exact) and tolerates trailing bytes,
    // and treats ANY 0x00-lead input as the identity (bytes 1..32 never
    // inspected). The prior strict adapter (require exactly 33; identity only
    // when all-zero) threw on `decodePoint(SELF.R4[3..]=514B, lead 0x00)` and
    // halted the validator. We now mirror sigma-rust exactly.
    it('treats any 0x00-lead input as identity (bytes 1..32 ignored)', () => {
      const b = new Uint8Array(33)
      for (let i = 1; i < 33; i++) b[i] = 0xff // 0x00 lead, non-zero tail
      expect(bytesEqual(encodePoint(decodePoint(b)), ZERO_33)).toBe(true)
    })

    it('tolerates trailing bytes (reads only the first 33)', () => {
      const pt = encodePoint(pointMul(basePoint, 7n)) // valid 33-byte point
      const withTrailing = new Uint8Array(pt.length + 481)
      withTrailing.set(pt, 0) // 481 trailing bytes left zero
      expect(bytesEqual(encodePoint(decodePoint(withTrailing)), pt)).toBe(true)
      // The exact iter-24 shape: 0x00-lead + long non-point tail → identity.
      const r4tail = new Uint8Array(514)
      for (let i = 1; i < 514; i++) r4tail[i] = (i * 7) & 0xff
      expect(bytesEqual(encodePoint(decodePoint(r4tail)), ZERO_33)).toBe(true)
    })
  })
})
