import { describe, expect, it } from 'vitest'
import * as avltree from '../src/index.js'
import { BatchAVLProver, StrictBatchAVLVerifier } from '../src/index.js'

describe('0.6.0 public surface', () => {
  it('adds StrictBatchAVLVerifier and nothing else', () => {
    // Runtime exports only: types leave no trace here.
    expect(Object.keys(avltree).sort()).toEqual([
      'AvlVerifyError',
      'BatchAVLProver',
      'BatchAVLVerifier',
      'PersistentBatchAVLProver',
      'StrictBatchAVLVerifier',
      'deserializeNode',
      'label',
      'newInternal',
      'newLabel',
      'newLeaf',
      'serializeNode',
      'verifyAvlBatch',
      'verifyAvlBatchPartial',
      'verifyAvlLookup',
    ])
  })

  it('keeps the strict verifier\'s machinery internal', () => {
    for (const name of [
      'VerifierCore',
      'RecordingVerifierCore',
      'matchesCanonicalProof',
      'validateConfig',
      'validateStartingDigest',
      'validateOperationShape',
    ]) {
      expect(name in avltree, name).toBe(false)
    }
  })

  it('StrictBatchAVLVerifier works through the package entry point', () => {
    const config = { keyLength: 32, valueLengthOpt: null }
    const insert = { tag: 'Insert', key: new Uint8Array(32).fill(7), value: new Uint8Array([1]) } as const
    const prover = new BatchAVLProver(32, null)
    const digest = prover.digest()
    const made = prover.generateProofForOperations([insert])
    if (!made.success) throw new Error('the insert must succeed on the prover')

    const v = new StrictBatchAVLVerifier(digest, made.proof, config)
    expect(v.performOneOperation(insert)).toEqual({ success: true, value: null })
    expect(v.digest()).toEqual(made.digest)
    expect(v.isFullyConsumed()).toBe(true)

    const padded = new StrictBatchAVLVerifier(digest, new Uint8Array([...made.proof, 0]), config)
    expect(padded.performOneOperation(insert)).toEqual({ success: true, value: null })
    expect(padded.digest()).toEqual(made.digest)
    expect(padded.isFullyConsumed()).toBe(false)
  })
})
