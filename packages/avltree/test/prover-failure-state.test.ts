import { describe, expect, it } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { AvlVerifyError } from '../src/errors.js'
import { verifyAvlBatch } from '../src/verify.js'
import type { Operation } from '../src/operation.js'
import { PersistentBatchAVLProver } from '../src/persistent-prover.js'
import type { VersionedAVLStorage } from '../src/versioned-storage.js'
import { SEVEN_KEYS, keyOf, keylessRight, pivot, sevenKeyProver, stubRight } from './helpers/tree-surgery.js'

const FIRST = SEVEN_KEYS[0]

describe('P2 — an operation never inherits `found` from a failed or thrown one (0.5.0)', () => {
  it('after a Lookup fails on a label stub in found mode, the next Lookup answers correctly', () => {
    const base = sevenKeyProver()
    const p = pivot(base.root, keyOf(FIRST))
    const prover = new BatchAVLProver(32, null)
    prover.restoreRoot(stubRight(base.root, p), base.height)

    expect(prover.performOneOperation({ tag: 'Lookup', key: p.key! })).toEqual({ success: false })
    expect(prover.performOneOperation({ tag: 'Lookup', key: keyOf(FIRST) })).toEqual({
      success: true,
      value: new Uint8Array([FIRST]),
    })
  })

  it('after a Lookup throws on a key-less internal node in found mode, the next Lookup answers correctly', () => {
    const base = sevenKeyProver()
    const p = pivot(base.root, keyOf(FIRST))
    const prover = new BatchAVLProver(32, null)
    prover.restoreRoot(keylessRight(base.root, p), base.height)

    expect(() => prover.performOneOperation({ tag: 'Lookup', key: p.key! })).toThrow(/InternalNode\.key is undefined/)
    // Rebase onto the intact tree: after an engine throw the proof cycle
    // needs one (P3). restoreRoot leaves `found` alone, as the reference's
    // restore_root does, so the next Lookup still tests perform's reset.
    prover.restoreRoot(base.root, base.height)
    expect(prover.performOneOperation({ tag: 'Lookup', key: keyOf(FIRST) })).toEqual({
      success: true,
      value: new Uint8Array([FIRST]),
    })
  })
})

describe('P3 — the prover fails stop after an engine throw (0.5.0)', () => {
  /**
   * A prover whose last operation threw inside the engine, and the intact tree
   * it came from. The Lookup reaches the key-less node in search mode, after
   * one direction bit, where the reference fails too (it unwraps the key).
   */
  function thrownProver(): { prover: BatchAVLProver; base: BatchAVLProver } {
    const base = sevenKeyProver()
    const p = pivot(base.root, keyOf(FIRST))
    const prover = new BatchAVLProver(32, null)
    prover.restoreRoot(keylessRight(base.root, p), base.height)
    expect(() => prover.performOneOperation({ tag: 'Lookup', key: keyOf(SEVEN_KEYS[4]) })).toThrow(/InternalNode\.key is undefined/)
    return { prover, base }
  }

  it('refuses every proof-cycle method after the throw', () => {
    const { prover } = thrownProver()
    expect(() => prover.performOneOperation({ tag: 'Lookup', key: keyOf(FIRST) })).toThrow(/indeterminate/)
    expect(() => prover.generateProof()).toThrow(/indeterminate/)
    expect(() => prover.removedNodes()).toThrow(/indeterminate/)
  })

  it('still answers root-only reads from the pre-operation root', () => {
    const { prover, base } = thrownProver()
    expect(prover.digest()).toEqual(base.digest())
    expect(prover.unauthenticatedLookup(keyOf(FIRST))).toEqual(new Uint8Array([FIRST]))
  })

  it('restoreRoot rebases the cycle and clears the mark', () => {
    const { prover, base } = thrownProver()
    prover.restoreRoot(base.root, base.height)
    const before = prover.digest()
    const op: Operation = { tag: 'Insert', key: keyOf(0x45), value: new Uint8Array([0x45]) }
    expect(prover.performOneOperation(op).success).toBe(true)
    const proof = prover.generateProof()
    expect(verifyAvlBatch(before, proof, { keyLength: 32, valueLengthOpt: null }, [op])?.newDigest).toEqual(prover.digest())
  })

  it('a shape error sets no mark', () => {
    const prover = sevenKeyProver()
    expect(() => prover.performOneOperation({ tag: 'Lookup', key: new Uint8Array(31).fill(1) })).toThrow(AvlVerifyError)
    expect(prover.performOneOperation({ tag: 'Lookup', key: keyOf(FIRST) }).success).toBe(true)
    expect(() => prover.generateProof()).not.toThrow()
  })

  it('an engine throw at the height check leaves root and height untouched', () => {
    const seed = new BatchAVLProver(32, null)
    seed.performOneOperation({ tag: 'Insert', key: keyOf(FIRST), value: new Uint8Array([FIRST]) })
    const prover = new BatchAVLProver(32, null)
    prover.restoreRoot(seed.root, 0) // a wrong height, as a storage backend could install one
    const before = prover.digest()
    expect(() => prover.performOneOperation({ tag: 'Remove', key: keyOf(FIRST) })).toThrow(/negative/)
    expect(prover.digest()).toEqual(before)
    expect(prover.unauthenticatedLookup(keyOf(FIRST))).toEqual(new Uint8Array([FIRST]))
  })

  it('an engine throw at the height check on the no-delete path leaves root and height untouched', () => {
    const seed = new BatchAVLProver(32, null)
    seed.performOneOperation({ tag: 'Insert', key: keyOf(FIRST), value: new Uint8Array([FIRST]) })
    const prover = new BatchAVLProver(32, null)
    prover.restoreRoot(seed.root, -1) // a negative height: even an Update's zero delta trips the check
    const rootBefore = prover.root
    expect(() =>
      prover.performOneOperation({ tag: 'Update', key: keyOf(FIRST), value: new Uint8Array([0x99]) }),
    ).toThrow(/negative/)
    expect(prover.root).toBe(rootBefore)
    expect(prover.height).toBe(-1)
  })

  it('PersistentBatchAVLProver: storage.update runs before the refusal; rollback clears the mark', () => {
    const base = sevenKeyProver()
    const saved = { root: base.root, height: base.height, digest: base.digest() }
    const seen: Uint8Array[] = []
    const storage: VersionedAVLStorage = {
      update: (prover) => {
        seen.push(prover.digest()) // a root-only read
      },
      rollback: () => [saved.root, saved.height],
      version: () => saved.digest,
      rollbackVersions: () => [saved.digest],
      flush: () => {},
    }
    const persistent = new PersistentBatchAVLProver(new BatchAVLProver(32, null), storage, [])
    const p = pivot(saved.root, keyOf(FIRST))
    persistent.prover.restoreRoot(keylessRight(saved.root, p), saved.height)
    expect(() => persistent.performOneOperation({ tag: 'Lookup', key: keyOf(SEVEN_KEYS[4]) })).toThrow(
      /InternalNode\.key is undefined/,
    )

    expect(() => persistent.generateProofAndUpdateStorage([])).toThrow(/indeterminate/)
    expect(seen).toEqual([saved.digest]) // update ran first, and saw the intact pre-operation root

    persistent.rollback(saved.digest)
    expect(persistent.performOneOperation({ tag: 'Lookup', key: keyOf(FIRST) })).toEqual({
      success: true,
      value: new Uint8Array([FIRST]),
    })
    expect(() => persistent.generateProofAndUpdateStorage([])).not.toThrow()
    expect(seen).toHaveLength(2)
  })
})
