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

  it('left-pads a short scalar (31 bytes) with one leading zero (sigma-rust read_scalar parity)', () => {
    // 55-byte proof: 24-byte challenge + 31-byte scalar.
    // Mirrors mainnet h=220541 tx1 input0 (P2PK Schnorr where the prover
    // emitted a 31-byte z because the leading byte was zero — sigma-rust's
    // read_scalar at sig_serializer.rs:250-255 accepts via right-shift into
    // a zero-filled GROUP_SIZE buffer).
    const proof = new Uint8Array(55)
    for (let i = 0; i < 24; i++) proof[i] = 0xa0 + i  // challenge filler
    for (let i = 0; i < 31; i++) proof[24 + i] = 0xb1 + i  // 31-byte scalar tail
    const reader = new ProofBytesReader(proof)
    reader.readChallenge()
    const scalar = reader.readScalarBytes()
    expect(scalar.length).toBe(32)
    expect(scalar[0]).toBe(0)            // left-padded
    expect(scalar[1]).toBe(0xb1)         // original byte 0 moved to position 1
    expect(scalar[31]).toBe(0xb1 + 30)   // original byte 30 ended at position 31
    expect(reader.remaining()).toBe(0)
  })

  it('left-pads a very short scalar (6 bytes) with 26 leading zeros', () => {
    // 30-byte buffer: 24 challenge + 6 scalar bytes. After my fix this no
    // longer throws — it returns a 32-byte zero-padded scalar (sigma-rust
    // parity). Previous behavior asserted a throw, which was wrong vs the
    // reference. See [[reference-source-first-discipline]].
    const proof = new Uint8Array(30)
    for (let i = 0; i < 6; i++) proof[24 + i] = 0xc0 + i
    const reader = new ProofBytesReader(proof)
    reader.readChallenge()
    const scalar = reader.readScalarBytes()
    expect(scalar.length).toBe(32)
    for (let i = 0; i < 26; i++) expect(scalar[i]).toBe(0)
    expect(scalar[26]).toBe(0xc0)
    expect(scalar[31]).toBe(0xc0 + 5)
    expect(reader.remaining()).toBe(0)
  })

  it('returns a 32-byte zero scalar when no scalar bytes remain (sigma-rust read returning 0)', () => {
    const reader = new ProofBytesReader(new Uint8Array(24))
    reader.readChallenge()  // consumes all 24
    const scalar = reader.readScalarBytes()
    expect(scalar.length).toBe(32)
    for (let i = 0; i < 32; i++) expect(scalar[i]).toBe(0)
  })

  it('still reads exactly 32 bytes when at least 32 remain', () => {
    const proof = new Uint8Array(64)
    for (let i = 0; i < 32; i++) proof[i] = 0xd0 + i
    const reader = new ProofBytesReader(proof)
    const scalar = reader.readScalarBytes()
    expect(scalar.length).toBe(32)
    expect(scalar[0]).toBe(0xd0)
    expect(scalar[31]).toBe(0xd0 + 31)
    expect(reader.remaining()).toBe(32)  // does NOT over-read
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
