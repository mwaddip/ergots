import { describe, expect, it } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
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
    prover.restoreRoot(base.root, base.height) // rebase onto the intact tree
    expect(prover.performOneOperation({ tag: 'Lookup', key: keyOf(FIRST) })).toEqual({
      success: true,
      value: new Uint8Array([FIRST]),
    })
  })
})
