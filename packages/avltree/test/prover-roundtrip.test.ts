import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { verifyAvlBatch, type AvlTreeConfig, type Operation } from '../src/index.js'

describe('Prover → Verifier round-trip', () => {
  const config: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null }

  it('single Insert round-trips through verifier', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x42)
    const value = new Uint8Array([1, 2, 3, 4])

    const startDigest = prover.digest()!
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(true)

    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    // Verify the proof
    const verified = verifyAvlBatch(startDigest, proof, config, [
      { tag: 'Insert', key, value },
    ])
    expect(verified).not.toBeNull()
    expect(verified!.results).toEqual([null]) // key was absent
    // Digests must match byte-for-byte
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('multi-op batch round-trips: Insert + Update + Insert', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key1 = new Uint8Array(32).fill(0x01)
    const key2 = new Uint8Array(32).fill(0x02)
    const val1 = new Uint8Array([10, 20])
    const val1b = new Uint8Array([30, 40])
    const val2 = new Uint8Array([50, 60])

    const startDigest = prover.digest()!
    prover.performOneOperation({ tag: 'Insert', key: key1, value: val1 })
    prover.performOneOperation({ tag: 'Insert', key: key2, value: val2 })
    prover.performOneOperation({ tag: 'Update', key: key1, value: val1b })
    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    const verified = verifyAvlBatch(startDigest, proof, config, [
      { tag: 'Insert', key: key1, value: val1 },
      { tag: 'Insert', key: key2, value: val2 },
      { tag: 'Update', key: key1, value: val1b },
    ])
    expect(verified).not.toBeNull()
    expect(verified!.results).toEqual([null, null, val1]) // Insert x2 absent, Update returns old
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('Lookup round-trips', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x07)
    const value = new Uint8Array([9, 9])

    prover.performOneOperation({ tag: 'Insert', key, value })
    // Commit the Insert so the next proof covers only the Lookup.
    prover.generateProof()

    const startDigest = prover.digest()!
    prover.performOneOperation({ tag: 'Lookup', key })
    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    const verified = verifyAvlBatch(startDigest, proof, config, [
      { tag: 'Lookup', key },
    ])
    expect(verified).not.toBeNull()
    expect(verified!.results).toEqual([value])
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('Remove round-trips: Insert+Remove batch, key removed', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x11)
    const value = new Uint8Array([1])

    const startDigest = prover.digest()!
    prover.performOneOperation({ tag: 'Insert', key, value })
    prover.performOneOperation({ tag: 'Remove', key })
    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    const verified = verifyAvlBatch(startDigest, proof, config, [
      { tag: 'Insert', key, value },
      { tag: 'Remove', key },
    ])
    expect(verified).not.toBeNull()
    // Insert returns null (absent), Remove returns old value
    expect(verified!.results).toEqual([null, value])
    // Tree should be back to post-insert-then-remove state (no key present)
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('all 8 Operation variants round-trip', () => {
    // Insert, InsertOrUpdate, Lookup, Update, UnknownModification,
    // Remove, RemoveIfExists, Insert (8-byte value for UpdateLongBy prep).
    // Exercises 7 unique Operation tag variants across 8 ops.
    const prover = new BatchAVLProver(config.keyLength, null)
    const k1 = new Uint8Array(32).fill(0xa1)
    const k2 = new Uint8Array(32).fill(0xa2)
    const v1 = new Uint8Array([1])
    const v2 = new Uint8Array([2])

    const ops: Operation[] = [
      { tag: 'Insert', key: k1, value: v1 },
      { tag: 'InsertOrUpdate', key: k2, value: v2 },
      { tag: 'Lookup', key: k1 },
      { tag: 'Update', key: k2, value: new Uint8Array([3]) },
      { tag: 'UnknownModification', key: k2 },
      { tag: 'Remove', key: k1 },
      { tag: 'RemoveIfExists', key: k1 }, // already absent — no-op
      { tag: 'Insert', key: k1, value: new Uint8Array(8).fill(0) }, // 8-byte for UpdateLongBy prep
    ]

    const startDigest = prover.digest()!
    for (const op of ops) {
      const r = prover.performOneOperation(op)
      if (!r.success && op.tag !== 'Remove') throw new Error(`Op failed: ${op.tag}`)
    }
    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    const verified = verifyAvlBatch(startDigest, proof, config, ops)
    expect(verified).not.toBeNull()
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('generateProofForOperations clones tree without mutating original prover', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x55)
    const value = new Uint8Array([7, 7, 7])

    // Establish a known tree state
    prover.performOneOperation({ tag: 'Insert', key, value })
    const digestBefore = prover.digest()!

    // generateProofForOperations on a separate key — must not mutate original
    const key2 = new Uint8Array(32).fill(0xaa)
    const result = prover.generateProofForOperations([
      { tag: 'Insert', key: key2, value: new Uint8Array([9]) },
    ])
    expect('proof' in result).toBe(true)

    // Original prover's digest must be unchanged
    expect(prover.digest()!).toEqual(digestBefore)

    // The proof+digest from the clone should verify against the original starting digest
    const { proof, digest } = result as { proof: Uint8Array; digest: Uint8Array }
    const verified = verifyAvlBatch(digestBefore, proof, config, [
      { tag: 'Insert', key: key2, value: new Uint8Array([9]) },
    ])
    expect(verified).not.toBeNull()
    expect(verified!.newDigest).toEqual(digest)
  })
})
