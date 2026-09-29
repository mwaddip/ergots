import { describe, expect, it } from 'vitest'
import * as avltree from '../src/index.js'
import {
  BatchAVLProver,
  PersistentBatchAVLProver,
  type AvlVerifyFailReason,
  type NeighborLookup,
  type NeighborLookupResult,
  type VersionedAVLStorage,
} from '../src/index.js'

function k(b: number): Uint8Array {
  const x = new Uint8Array(32)
  x[0] = b
  return x
}

describe('0.5.0 public surface', () => {
  it('exports BatchAVLVerifier and keeps VerifierCore and neighborLookupOf internal', () => {
    expect(typeof avltree.BatchAVLVerifier).toBe('function')
    expect('VerifierCore' in avltree).toBe(false)
    expect('neighborLookupOf' in avltree).toBe(false)
  })

  it('exports the neighbor and fail-reason types', () => {
    // Compile-time probes: these annotations are the assertions.
    const found: NeighborLookup = { found: true, value: new Uint8Array(1), nextKey: null }
    const result: NeighborLookupResult = { success: true, ...found }
    const reason: AvlVerifyFailReason = 'digest-mismatch'
    expect([found.found, result.success, reason]).toEqual([true, true, 'digest-mismatch'])
  })

  it('PersistentBatchAVLProver passes both neighbor lookups through', () => {
    const seed = new BatchAVLProver(32, null)
    seed.performOneOperation({ tag: 'Insert', key: k(0x20), value: new Uint8Array([0x20]) })
    const savedRoot = seed.root
    const savedHeight = seed.height
    const savedDigest = seed.digest()
    const storage: VersionedAVLStorage = {
      update: () => {},
      rollback: () => [savedRoot, savedHeight],
      version: () => savedDigest,
      rollbackVersions: () => [savedDigest],
      flush: () => {},
    }
    const persistent = new PersistentBatchAVLProver(new BatchAVLProver(32, null), storage, [])
    expect(persistent.unauthenticatedLookupWithNeighbors(k(0x20))).toEqual({
      found: true,
      value: new Uint8Array([0x20]),
      nextKey: null,
    })
    expect(persistent.performLookupWithNeighbors(k(0x10))).toEqual({
      success: true,
      found: false,
      prevKey: null,
      nextKey: k(0x20),
    })
  })
})
