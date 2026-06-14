import { describe, expect, it } from 'vitest'
import { unsignedBeBytesToBigInt } from '../../src/eval/_byte-coll'

describe('unsignedBeBytesToBigInt', () => {
  it('decodes empty bytes to 0n (matches BigIntegers.fromUnsignedByteArray([]))', () => {
    expect(unsignedBeBytesToBigInt(new Uint8Array([]))).toBe(0n)
  })
  it('decodes big-endian unsigned, never sign-extending', () => {
    expect(unsignedBeBytesToBigInt(Uint8Array.of(0xff))).toBe(255n)
    expect(unsignedBeBytesToBigInt(Uint8Array.of(0x01, 0x00))).toBe(256n)
    expect(unsignedBeBytesToBigInt(Uint8Array.of(0xff, 0xff))).toBe(65535n)
  })
  it('decodes a full 32-byte max to 2^256 - 1', () => {
    const max = new Uint8Array(32).fill(0xff)
    expect(unsignedBeBytesToBigInt(max)).toBe((1n << 256n) - 1n)
  })
})
