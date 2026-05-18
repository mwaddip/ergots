import { describe, expect, it } from 'vitest'
import { nextDirectionIsLeft, type TraversalState } from '../src/tree-traversal.js'

describe('nextDirectionIsLeft', () => {
  it('reads bit 0 of byte 0 as left=true', () => {
    // proof[0] bit 0 set → left=true
    const proof = new Uint8Array([0b00000001])
    const state: TraversalState = { directionsIndex: 0, lastRightStep: 0, replayIndex: 0 }
    expect(nextDirectionIsLeft(proof, state)).toBe(true)
    expect(state.directionsIndex).toBe(1)
    expect(state.lastRightStep).toBe(0)  // not updated on left
  })
  it('reads bit 0 of byte 0 as left=false (right step)', () => {
    const proof = new Uint8Array([0b00000000])
    const state: TraversalState = { directionsIndex: 0, lastRightStep: -1, replayIndex: 0 }
    expect(nextDirectionIsLeft(proof, state)).toBe(false)
    expect(state.directionsIndex).toBe(1)
    expect(state.lastRightStep).toBe(0)  // captures the pre-advance index (was -1)
  })
  it('advances bit position across byte boundary', () => {
    // Bits: 0,0,0,0,0,0,0,0, 1,1,1,1,...
    const proof = new Uint8Array([0x00, 0xff])
    const state: TraversalState = { directionsIndex: 7, lastRightStep: 0, replayIndex: 0 }
    expect(nextDirectionIsLeft(proof, state)).toBe(false)   // bit 7 of byte 0
    expect(nextDirectionIsLeft(proof, state)).toBe(true)    // bit 0 of byte 1
    expect(state.directionsIndex).toBe(9)
  })
})
