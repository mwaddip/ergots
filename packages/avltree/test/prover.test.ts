import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'

describe('BatchAVLProver', () => {
  it('constructs an empty tree and produces a valid digest', () => {
    const prover = new BatchAVLProver(32, null)
    const d = prover.digest()
    expect(d).not.toBeNull()
    expect(d!.length).toBe(33)
    // Height byte is the last byte; empty tree is a single sentinel leaf → height 0
    expect(d![32]).toBe(0)
    // The root label is deterministic — blake2b of (0x00 || negInfKey || dummyValue || posInfKey)
    // Verify the root label is non-zero (not all zeroes)
    const rootLabel = d!.slice(0, 32)
    const allZero = rootLabel.every((b) => b === 0)
    expect(allZero).toBe(false)
  })

  it('accepts an Insert and returns null old value', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value).toBeNull() // key was absent
    }
  })

  it('rejects Insert on existing key', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(false)
  })

  it('digest changes after Insert', () => {
    const prover = new BatchAVLProver(32, null)
    const before = prover.digest()!
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const after = prover.digest()!
    // Digest should change after insertion
    expect(after).not.toEqual(before)
    // Height should still be valid (0 or 1 — depends on tree shape after single insert)
    expect(after[32]).toBeGreaterThanOrEqual(0)
  })

  it('unauthenticatedLookup returns the inserted value', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const lookedUp = prover.unauthenticatedLookup(key)
    expect(lookedUp).not.toBeNull()
    expect(lookedUp).toEqual(value)
  })

  it('unauthenticatedLookup returns null for absent key', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const absentKey = new Uint8Array(32)
    absentKey.fill(0x02)
    const lookedUp = prover.unauthenticatedLookup(absentKey)
    expect(lookedUp).toBeNull()
  })

  it('throws on key shorter than tree key length', () => {
    const prover = new BatchAVLProver(32, null)
    const shortKey = new Uint8Array(16)
    expect(() =>
      prover.performOneOperation({ tag: 'Insert', key: shortKey, value: new Uint8Array([1]) }),
    ).toThrow()
  })

  it('throws on key longer than tree key length', () => {
    const prover = new BatchAVLProver(32, null)
    const longKey = new Uint8Array(64)
    expect(() =>
      prover.performOneOperation({ tag: 'Insert', key: longKey, value: new Uint8Array([1]) }),
    ).toThrow()
  })

  it('throws on value length mismatch when fixed value length is set', () => {
    const prover = new BatchAVLProver(32, 8) // fixed 8-byte values
    const key = new Uint8Array(32)
    const wrongValue = new Uint8Array([1, 2, 3]) // 3 bytes, not 8
    expect(() =>
      prover.performOneOperation({ tag: 'Insert', key, value: wrongValue }),
    ).toThrow()
  })

  it('accepts any value length when valueLengthOpt is null', () => {
    const prover = new BatchAVLProver(32, null) // variable-length values
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3, 4, 5])
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(true)
  })

  it('generateProof returns a non-empty proof after operations', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    const proof = prover.generateProof()
    expect(proof.length).toBeGreaterThan(0)
  })

  it('generateProofForOperations returns proof and digest on success', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    // Seed with one insert so the tree is non-empty
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    const result = prover.generateProofForOperations([
      { tag: 'Update', key: new Uint8Array(32).fill(0x01), value: new Uint8Array([4, 5, 6]) },
    ])
    expect(result).not.toHaveProperty('success', false)
    if ('proof' in result) {
      expect(result.proof.length).toBeGreaterThan(0)
      expect(result.digest.length).toBe(33)
    }
  })

  it('generateProofForOperations returns success:false on failed operation', () => {
    const prover = new BatchAVLProver(32, null)
    // No key inserted — Update on absent key should fail
    const result = prover.generateProofForOperations([
      { tag: 'Update', key: new Uint8Array(32).fill(0x01), value: new Uint8Array([1, 2, 3]) },
    ])
    expect(result).toEqual({ success: false })
  })

  it('supports Update operation after Insert', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    const result = prover.performOneOperation({
      tag: 'Update',
      key,
      value: new Uint8Array([4, 5, 6]),
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value).toEqual(new Uint8Array([1, 2, 3])) // old value returned
    }
    // Lookup should now return updated value
    expect(prover.unauthenticatedLookup(key)).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('supports Remove operation', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    const result = prover.performOneOperation({ tag: 'Remove', key })
    expect(result.success).toBe(true)
    expect(prover.unauthenticatedLookup(key)).toBeNull()
  })

  it('supports multiple inserts and lookups', () => {
    const prover = new BatchAVLProver(32, null)
    for (let i = 1; i <= 5; i++) {
      const key = new Uint8Array(32)
      key[0] = i
      const value = new Uint8Array([i])
      const result = prover.performOneOperation({ tag: 'Insert', key, value })
      expect(result.success).toBe(true)
    }
    // Verify all keys are present
    for (let i = 1; i <= 5; i++) {
      const key = new Uint8Array(32)
      key[0] = i
      expect(prover.unauthenticatedLookup(key)).toEqual(new Uint8Array([i]))
    }
    // Absent key
    const absentKey = new Uint8Array(32)
    absentKey[0] = 99
    expect(prover.unauthenticatedLookup(absentKey)).toBeNull()
  })
})

describe('BatchAVLProver.restoreRoot', () => {
  it('rebases the proof cycle on a restored tree', () => {
    // Build a tree with some entries, snapshot its root + digest.
    const src = new BatchAVLProver(32, null)
    for (let i = 0; i < 5; i++) {
      const key = new Uint8Array(32)
      key[0] = 0x10 + i
      key[31] = 0x10 + i
      const value = new Uint8Array([i, i, i])
      const r = src.performOneOperation({ tag: 'Insert', key, value })
      expect(r.success).toBe(true)
    }
    const srcDigest = src.digest()
    expect(srcDigest).not.toBeNull()

    // Snapshot root and height.
    const savedRoot = src.root
    const savedHeight = src.height
    expect(savedRoot).not.toBeNull()
    expect(savedHeight).toBeGreaterThan(0)

    // Restore into a fresh prover.
    const restored = new BatchAVLProver(32, null)
    restored.restoreRoot(savedRoot!, savedHeight)

    // Digest must match.
    const restoredDigest = restored.digest()
    expect(restoredDigest).not.toBeNull()
    expect(restoredDigest).toEqual(srcDigest)

    // Perform an operation on the restored tree — must succeed.
    // Must not be all-zeroes (negative-infinity key) or all-0xff (positive-infinity key).
    const newKey = new Uint8Array(32)
    newKey.fill(0x99)
    const r = restored.performOneOperation({
      tag: 'Insert',
      key: newKey,
      value: new Uint8Array([9, 9, 9]),
    })
    expect(r.success).toBe(true)

    // Generate a proof from the restored prover.
    const proof = restored.generateProof()
    expect(proof).not.toBeNull()
    // Proof should be non-empty (at least one operation)
    expect(proof!.length).toBeGreaterThan(0)
  })

  it('allows lookup on restored tree', () => {
    const src = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key[0] = 0x42
    key[31] = 0x42
    const value = new Uint8Array([0xab, 0xcd])
    src.performOneOperation({ tag: 'Insert', key, value })

    const restored = new BatchAVLProver(32, null)
    restored.restoreRoot(src.root!, src.height)

    // Lookup must find the inserted key.
    expect(restored.unauthenticatedLookup(key)).toEqual(value)
  })
})
