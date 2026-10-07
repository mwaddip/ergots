import { describe, it, expect } from 'vitest'
import { compareBytes, negInfKey, posInfKey } from '../src/compare-bytes.js'

describe('compareBytes', () => {
  it('equal arrays compare 0', () => {
    expect(compareBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(0)
    expect(compareBytes(new Uint8Array(0), new Uint8Array(0))).toBe(0)
  })
  it('first differing byte decides', () => {
    expect(compareBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 3, 0]))).toBe(-1)
    expect(compareBytes(new Uint8Array([2]), new Uint8Array([1, 0xff]))).toBe(1)
  })
  it('shared prefix: length tiebreak (shorter < longer)', () => {
    expect(compareBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(-1)
    expect(compareBytes(new Uint8Array([1, 2, 0]), new Uint8Array([1, 2]))).toBe(1)
    expect(compareBytes(new Uint8Array(0), new Uint8Array([0]))).toBe(-1)
  })
  it('unsigned comparison (0x80 > 0x7f)', () => {
    expect(compareBytes(new Uint8Array([0x80]), new Uint8Array([0x7f]))).toBe(1)
  })
})

describe('negInfKey', () => {
  it('returns a keyLength-long run of 0x00', () => {
    expect(negInfKey(1)).toEqual(new Uint8Array([0x00]))
    expect(negInfKey(32)).toEqual(new Uint8Array(32))
    expect(negInfKey(65)).toEqual(new Uint8Array(65))
  })
  it('returns a fresh buffer on every call', () => {
    const a = negInfKey(32)
    const b = negInfKey(32)
    expect(a).not.toBe(b)
    a[0] = 0x01
    expect(b[0]).toBe(0x00)
  })
})

describe('posInfKey', () => {
  it('returns a keyLength-long run of 0xff', () => {
    expect(posInfKey(1)).toEqual(new Uint8Array([0xff]))
    expect(posInfKey(32)).toEqual(new Uint8Array(32).fill(0xff))
    expect(posInfKey(65)).toEqual(new Uint8Array(65).fill(0xff))
  })
  it('returns a fresh buffer on every call', () => {
    const a = posInfKey(32)
    const b = posInfKey(32)
    expect(a).not.toBe(b)
    a[0] = 0x00
    expect(b[0]).toBe(0xff)
  })
})

describe('sentinel helpers vs compareBytes', () => {
  it('negInfKey < posInfKey for the same keyLength', () => {
    expect(compareBytes(negInfKey(32), posInfKey(32))).toBe(-1)
  })
  it('every valid key is strictly between the two sentinels', () => {
    const k = new Uint8Array(32).fill(0x7f)
    expect(compareBytes(k, negInfKey(32))).toBe(1)
    expect(compareBytes(k, posInfKey(32))).toBe(-1)
  })
})
