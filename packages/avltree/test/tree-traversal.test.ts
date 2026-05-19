import { describe, expect, it } from 'vitest'
import { nextDirectionIsLeft, replayComparison, keyMatchesLeaf, type TraversalState } from '../src/tree-traversal.js'
import { newLeaf } from '../src/node.js'

describe('nextDirectionIsLeft', () => {
  it('reads bit 0 of byte 0 as left=true', () => {
    // proof[0] bit 0 set → left=true
    const proof = new Uint8Array([0b00000001])
    const state: TraversalState = { directionsIndex: 0, lastRightStep: 0, replayIndex: 0, failedReason: null }
    expect(nextDirectionIsLeft(proof, state)).toBe(true)
    expect(state.directionsIndex).toBe(1)
    expect(state.lastRightStep).toBe(0)  // not updated on left
  })
  it('reads bit 0 of byte 0 as left=false (right step)', () => {
    const proof = new Uint8Array([0b00000000])
    const state: TraversalState = { directionsIndex: 0, lastRightStep: -1, replayIndex: 0, failedReason: null }
    expect(nextDirectionIsLeft(proof, state)).toBe(false)
    expect(state.directionsIndex).toBe(1)
    expect(state.lastRightStep).toBe(0)  // captures the pre-advance index (was -1)
  })
  it('advances bit position across byte boundary', () => {
    // Bits: 0,0,0,0,0,0,0,0, 1,1,1,1,...
    const proof = new Uint8Array([0x00, 0xff])
    const state: TraversalState = { directionsIndex: 7, lastRightStep: 0, replayIndex: 0, failedReason: null }
    expect(nextDirectionIsLeft(proof, state)).toBe(false)   // bit 7 of byte 0
    expect(nextDirectionIsLeft(proof, state)).toBe(true)    // bit 0 of byte 1
    expect(state.directionsIndex).toBe(9)
  })
})

describe('replayComparison', () => {
  // Specific bit patterns: see batch_avl_verifier.rs lines 239-251.
  it('returns 0 when replayIndex equals lastRightStep', () => {
    const proof = new Uint8Array([0xff])
    const state: TraversalState = { directionsIndex: 8, lastRightStep: 4, replayIndex: 4, failedReason: null }
    expect(replayComparison(proof, state)).toBe(0)
    expect(state.replayIndex).toBe(5)
  })
  it('returns 1 when bit unset and replayIndex < lastRightStep', () => {
    const proof = new Uint8Array([0x00])
    const state: TraversalState = { directionsIndex: 8, lastRightStep: 4, replayIndex: 2, failedReason: null }
    expect(replayComparison(proof, state)).toBe(1)
  })
  it('returns -1 otherwise', () => {
    const proof = new Uint8Array([0xff])
    const state: TraversalState = { directionsIndex: 8, lastRightStep: 4, replayIndex: 2, failedReason: null }
    expect(replayComparison(proof, state)).toBe(-1)
  })
})

describe('keyMatchesLeaf', () => {
  it('returns true when key === leaf.key', () => {
    const key = new Uint8Array([1, 2, 3])
    const leaf = newLeaf(key, new Uint8Array([10]), new Uint8Array([5, 6, 7]))
    expect(keyMatchesLeaf(key, leaf)).toEqual({ ok: true, matches: true })
  })
  it('returns false when leaf.key < key < leaf.nextLeafKey', () => {
    const leaf = newLeaf(new Uint8Array([1, 0, 0]), new Uint8Array([10]), new Uint8Array([2, 0, 0]))
    expect(keyMatchesLeaf(new Uint8Array([1, 5, 0]), leaf)).toEqual({ ok: true, matches: false })
  })
  it('fails when key not in [leaf.key, leaf.nextLeafKey)', () => {
    const leaf = newLeaf(new Uint8Array([1, 0, 0]), new Uint8Array([10]), new Uint8Array([2, 0, 0]))
    expect(keyMatchesLeaf(new Uint8Array([5, 0, 0]), leaf)).toEqual({ ok: false, reason: 'leaf-key-out-of-order' })
  })
  it('fails when key < leaf.key', () => {
    const leaf = newLeaf(new Uint8Array([1, 0, 0]), new Uint8Array([10]), new Uint8Array([2, 0, 0]))
    expect(keyMatchesLeaf(new Uint8Array([0, 5, 0]), leaf)).toEqual({ ok: false, reason: 'leaf-key-out-of-order' })
  })
})
