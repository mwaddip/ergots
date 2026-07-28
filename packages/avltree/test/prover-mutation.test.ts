/**
 * Prover proof mutation → verifier rejection.
 *
 * Creates a proof from a BatchAVLProver, flips the LSB of each byte in the
 * proof, and asserts that ≥90% of flips cause the verifier to return null.
 *
 * This is a focused complement to the broader fixture-driven mutation test
 * (mutation.test.ts): that one XORs 0xff against committed fixture proofs;
 * this one XORs 0x01 against a freshly generated prover proof, exercising
 * the end-to-end prover → verifier chain under mutation.
 */
import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { verifyAvlBatch, type AvlTreeConfig } from '../src/index.js'

describe('Prover proof mutation → verifier rejects', () => {
  it('single-byte flips cause verification failure at ≥90% kill rate', () => {
    const config: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null }
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x55)
    const value = new Uint8Array([1, 2, 3, 4])

    const startDigest = prover.digest()!
    prover.performOneOperation({ tag: 'Insert', key, value })
    const proof = prover.generateProof()

    let killed = 0
    for (let i = 0; i < proof.length; i++) {
      const mutated = new Uint8Array(proof)
      mutated[i] ^= 0x01 // flip LSB
      const result = verifyAvlBatch(startDigest, mutated, config, [
        { tag: 'Insert', key, value },
      ])
      if (result === null) killed++
    }
    const killRate = killed / proof.length
    expect(killRate).toBeGreaterThanOrEqual(0.9)
  })
})
