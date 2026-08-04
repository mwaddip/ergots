import { describe, it, expect } from 'vitest'
import { compareBytes } from '../src/compare-bytes.js'

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
