import { describe, expect, it } from 'vitest'
import { newLeaf, newInternal, newLabel, label } from '../src/node.js'

// These fixtures will be replaced in Task 8/13 with real Rust-prover outputs.
// For now, validate structural invariants:
//   - 32-byte output
//   - idempotent caching (same byte content on repeated calls; references differ due to defensive slice)
//   - label-node passthrough (stored label returned verbatim, no re-hash)
//   - balance byte affects the digest

describe('label — leaf node', () => {
  it('produces a 32-byte digest', () => {
    const key = new Uint8Array([0x01, 0x02, 0x03, 0x04])
    const value = new Uint8Array([0xaa, 0xbb])
    const nextKey = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const leaf = newLeaf(key, value, nextKey)
    const lbl = label(leaf)
    expect(lbl.length).toBe(32)
  })
  it('caches the label on first call (idempotent byte content)', () => {
    const leaf = newLeaf(
      new Uint8Array([1]),
      new Uint8Array([10]),
      new Uint8Array([5]),
    )
    const lbl = label(leaf)
    // label() returns a fresh slice each time (defensive copy); check byte-equality, not reference.
    expect(Array.from(label(leaf))).toEqual(Array.from(lbl))
    // The internal cache should be populated after the first call.
    expect(leaf.labelCache).not.toBeNull()
  })
})

describe('label — internal node', () => {
  it('produces a 32-byte digest', () => {
    const leftLeaf = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([5]))
    const rightLeaf = newLeaf(new Uint8Array([5]), new Uint8Array([50]), new Uint8Array([255]))
    const internal = newInternal(leftLeaf, rightLeaf, 0)
    const lbl = label(internal)
    expect(lbl.length).toBe(32)
  })
  it('caches the label on first call (idempotent byte content)', () => {
    const leftLeaf = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([5]))
    const rightLeaf = newLeaf(new Uint8Array([5]), new Uint8Array([50]), new Uint8Array([255]))
    const internal = newInternal(leftLeaf, rightLeaf, 0)
    const lbl = label(internal)
    // label() returns a fresh slice each time (defensive copy); check byte-equality, not reference.
    expect(Array.from(label(internal))).toEqual(Array.from(lbl))
    // The internal cache should be populated after the first call.
    expect(internal.labelCache).not.toBeNull()
  })
  it('different balance produces different label', () => {
    const leftLeaf = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([5]))
    const rightLeaf = newLeaf(new Uint8Array([5]), new Uint8Array([50]), new Uint8Array([255]))
    const a = newInternal(leftLeaf, rightLeaf, 0)
    const b = newInternal(leftLeaf, rightLeaf, 1)
    expect(Array.from(label(a))).not.toEqual(Array.from(label(b)))
  })
  it('balance = -1 produces a different label from balance = 0', () => {
    const leftLeaf = newLeaf(new Uint8Array([1]), new Uint8Array([10]), new Uint8Array([5]))
    const rightLeaf = newLeaf(new Uint8Array([5]), new Uint8Array([50]), new Uint8Array([255]))
    const a = newInternal(leftLeaf, rightLeaf, 0)
    const b = newInternal(leftLeaf, rightLeaf, -1)
    expect(Array.from(label(a))).not.toEqual(Array.from(label(b)))
    // Sanity: both digests are still 32 bytes.
    expect(label(b).length).toBe(32)
  })
})

describe('label — label node', () => {
  it('returns the stored label directly (32 bytes)', () => {
    const stored = new Uint8Array(32).fill(0xab)
    const node = newLabel(stored)
    const lbl = label(node)
    expect(lbl.length).toBe(32)
    expect(Array.from(lbl)).toEqual(Array.from(stored))
  })
  it('returns the same byte content on repeated calls (fresh slice each time)', () => {
    const stored = new Uint8Array(32).fill(0xab)
    const node = newLabel(stored)
    // label() slices defensively; references differ, bytes are equal.
    expect(Array.from(label(node))).toEqual(Array.from(label(node)))
  })
})
