import { describe, it, expect } from 'vitest'
import { containsLabel } from '../src/batch-prover.js'
import { newLeaf, newInternal, newLabel } from '../src/node.js'

// 32-byte key strictly inside (all-0, all-ff): byte0=1, byte31=n.
const k = (n: number) => {
  const a = new Uint8Array(32)
  a[0] = 1
  a[31] = n
  return a
}
const v = (n: number) => {
  const a = new Uint8Array(8)
  a[7] = n
  return a
}
const NEG_INF = new Uint8Array(32)
const rand32 = new Uint8Array(32).fill(0xab)

describe('containsLabel', () => {
  // Two-leaf tree: negInf sentinel leaf -> leafB, top internal keyed on B.
  const leafNeg = newLeaf(NEG_INF, new Uint8Array(8), k(5))
  const leafB = newLeaf(k(5), v(1), new Uint8Array(32).fill(0xff))
  const top = newInternal(leafNeg, leafB, 0, k(5))

  it('immediate label match at the root', () => {
    expect(containsLabel(top, top)).toBe(true)
  })

  it('found-descent to a matching leaf (key-equal -> right, then leaf)', () => {
    expect(containsLabel(top, leafB)).toBe(true)
  })

  it('same key, different content -> absent', () => {
    const leafB2 = newLeaf(k(5), v(2), new Uint8Array(32).fill(0xff))
    expect(containsLabel(top, leafB2)).toBe(false)
  })

  it('internal candidate with matching key but different label -> absent', () => {
    const other = newInternal(leafNeg, newLeaf(k(5), v(9), new Uint8Array(32).fill(0xff)), 0, k(5))
    expect(containsLabel(top, other)).toBe(false)
  })

  it('LabelNode stub on the descent path -> fail-safe present', () => {
    // Stub replaces the left subtree; candidate key routes left into it.
    const stubTop = newInternal(newLabel(rand32), leafB, 0, k(5))
    const probe = newLeaf(k(3), v(3), k(5)) // k(3) < k(5) -> descend left -> stub
    expect(containsLabel(stubTop, probe)).toBe(true)
  })

  it('LabelNode candidate -> invariant throw', () => {
    expect(() => containsLabel(top, newLabel(rand32))).toThrow(/invariant/)
  })

  it('key-less internal candidate -> invariant throw', () => {
    const keyless = newInternal(leafNeg, leafB, 0)
    expect(() => containsLabel(top, keyless)).toThrow(/invariant/)
  })

  it('key-less internal on the descent -> invariant throw', () => {
    const badTop = newInternal(leafNeg, leafB, 0) // no key
    expect(() => containsLabel(badTop, leafB)).toThrow(/invariant/)
  })
})
