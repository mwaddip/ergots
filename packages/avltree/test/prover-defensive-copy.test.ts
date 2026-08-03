import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { verifyAvlBatch } from '../src/verify.js'
import type { Operation } from '../src/operation.js'

const CONFIG = { keyLength: 32, valueLengthOpt: null }

function freshKey(fill: number): Uint8Array {
  const k = new Uint8Array(32).fill(fill)
  k[31] = 1 // keep strictly inside the ±inf sentinels
  return k
}

/** Seal a cycle, mutate a buffer the prover returned, then round-trip the
 * NEXT cycle's proof through the verifier. Pre-fix the mutation corrupts the
 * emitted proof bytes (stale cached labels vs mutated leaf bytes) and the
 * verifier returns null; post-fix (copies) it must verify. */
describe('prover returns defensive copies (C7)', () => {
  it('mutating a Lookup result cannot corrupt the next proof', () => {
    const prover = new BatchAVLProver(32, null)
    const key = freshKey(0x07)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    prover.generateProof()
    const digest = prover.digest()
    if (digest === null) throw new Error('setup: digest null') // drops after C8

    const lookup = prover.performOneOperation({ tag: 'Lookup', key })
    if (!lookup.success || lookup.value === null) throw new Error('setup: lookup failed')
    lookup.value.fill(0xee) // caller scribbles on the returned buffer

    const op: Operation = { tag: 'Lookup', key }
    prover.performOneOperation(op) // note: first Lookup already consumed cycle 2; see step 2
    const proof = prover.generateProof()
    expect(verifyAvlBatch(digest, proof, CONFIG, [op])).not.toBeNull()
  })

  it('mutating unauthenticatedLookup result cannot corrupt the next proof', () => {
    const prover = new BatchAVLProver(32, null)
    const key = freshKey(0x09)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([9, 9, 9]) })
    prover.generateProof()
    const digest = prover.digest()
    if (digest === null) throw new Error('setup: digest null')

    const value = prover.unauthenticatedLookup(key)
    if (value === null) throw new Error('setup: unauthenticated lookup missed')
    value.fill(0xee)

    const op: Operation = { tag: 'Lookup', key }
    prover.performOneOperation(op)
    const proof = prover.generateProof()
    expect(verifyAvlBatch(digest, proof, CONFIG, [op])).not.toBeNull()
  })

  it('mutating an Update result (old value) cannot corrupt the next proof', () => {
    const prover = new BatchAVLProver(32, null)
    const key = freshKey(0x0b)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([4, 5, 6]) })
    prover.generateProof()
    const digest = prover.digest()
    if (digest === null) throw new Error('setup: digest null')

    const op: Operation = { tag: 'Update', key, value: new Uint8Array([7, 7, 7]) }
    const updated = prover.performOneOperation(op)
    if (!updated.success || updated.value === null) throw new Error('setup: update failed')
    updated.value.fill(0xee) // the OLD value buffer — pre-fix it aliases a leaf packTree emits

    const proof = prover.generateProof()
    expect(verifyAvlBatch(digest, proof, CONFIG, [op])).not.toBeNull()
  })
})
