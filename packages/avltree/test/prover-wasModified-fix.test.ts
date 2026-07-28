import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { verifyAvlBatch, type AvlTreeConfig } from '../src/index.js'

describe('BatchAVLProver wasModified fix', () => {
  const config: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null }

  it('Insert → generateProof → Remove → generateProof round-trips', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x42)
    const value = new Uint8Array([1, 2, 3, 4])

    // Batch 1: Insert
    const startDigest1 = prover.digest()!
    const r1 = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(r1.success).toBe(true)

    const proof1 = prover.generateProof()
    const endDigest1 = prover.digest()!

    // Verify first proof
    const verified1 = verifyAvlBatch(startDigest1, proof1, config, [
      { tag: 'Insert', key, value },
    ])
    expect(verified1).not.toBeNull()
    expect(verified1!.results).toEqual([null]) // key was absent
    expect(verified1!.newDigest).toEqual(endDigest1)

    // Batch 2: Remove — uses endDigest1 as starting digest
    const r2 = prover.performOneOperation({ tag: 'Remove', key })
    expect(r2.success).toBe(true)

    const proof2 = prover.generateProof()
    const endDigest2 = prover.digest()!

    // Verify second proof — THIS IS THE BUG: currently fails because
    // the left-sibling leaf is emitted as LABEL instead of LEAF
    const verified2 = verifyAvlBatch(endDigest1, proof2, config, [
      { tag: 'Remove', key },
    ])
    expect(verified2).not.toBeNull()
    expect(verified2!.results).toEqual([value]) // Remove returns old value
    expect(verified2!.newDigest).toEqual(endDigest2)
  })
})
