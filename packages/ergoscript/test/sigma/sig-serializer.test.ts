import { describe, it, expect } from 'vitest'
import { readProofBytes, ProofBytesReader } from '../../src/sigma/sig-serializer'
import { CHALLENGE_BYTES } from '../../src/sigma/challenge'
import { VerifyError } from '../../src/sigma/errors'

describe('ProofBytesReader', () => {
  it('reads a 24-byte top-level challenge from a 56-byte ProveDlog proof', () => {
    const proof = new Uint8Array(56)
    for (let i = 0; i < 24; i++) proof[i] = 0xa0 + i
    for (let i = 0; i < 32; i++) proof[24 + i] = 0xb0 + i
    const reader = new ProofBytesReader(proof)
    const challenge = reader.readChallenge()
    expect(challenge.length).toBe(CHALLENGE_BYTES)
    expect(challenge[0]).toBe(0xa0)
    expect(challenge[23]).toBe(0xa0 + 23)
  })

  it('reads a 32-byte scalar following the challenge', () => {
    const proof = new Uint8Array(56)
    proof[24] = 0xff  // first byte of the 32-byte scalar
    proof[55] = 0x01  // last byte
    const reader = new ProofBytesReader(proof)
    reader.readChallenge()
    const scalar = reader.readScalarBytes()
    expect(scalar.length).toBe(32)
    expect(scalar[0]).toBe(0xff)
    expect(scalar[31]).toBe(0x01)
  })

  it('throws truncated-signature when challenge bytes missing', () => {
    const reader = new ProofBytesReader(new Uint8Array(10))
    expect(() => reader.readChallenge()).toThrow(VerifyError)
    try { new ProofBytesReader(new Uint8Array(10)).readChallenge() }
    catch (e: any) { expect(e.code).toBe('truncated-signature') }
  })

  it('throws truncated-signature when scalar bytes missing', () => {
    const reader = new ProofBytesReader(new Uint8Array(30))
    reader.readChallenge()  // succeeds (24 bytes)
    expect(() => reader.readScalarBytes()).toThrow(VerifyError)
    const reader2 = new ProofBytesReader(new Uint8Array(30))
    reader2.readChallenge()
    try { reader2.readScalarBytes() }
    catch (e: any) { expect(e.code).toBe('truncated-signature') }
  })

  it('throws empty-signature on zero-length input via readProofBytes guard', () => {
    expect(() => readProofBytes(new Uint8Array(0))).toThrow(VerifyError)
    try { readProofBytes(new Uint8Array(0)) }
    catch (e: any) { expect(e.code).toBe('empty-signature') }
  })
})

describe('ProofBytesReader.readBytes', () => {
  it('returns the next n bytes', () => {
    const r = new ProofBytesReader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    expect(Array.from(r.readBytes(3))).toEqual([1, 2, 3])
    expect(Array.from(r.readBytes(2))).toEqual([4, 5])
  })
  it('throws truncated-signature on underrun', () => {
    const r = new ProofBytesReader(new Uint8Array([1, 2, 3]))
    expect(() => r.readBytes(5)).toThrow(
      expect.objectContaining({ code: 'truncated-signature' }),
    )
  })
  it('returns defensive copies', () => {
    const buf = new Uint8Array([1, 2, 3, 4])
    const r = new ProofBytesReader(buf)
    const result = r.readBytes(2)
    result[0] = 99
    expect(buf[0]).toBe(1)  // original unchanged
  })
})
