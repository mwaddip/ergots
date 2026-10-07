import { describe, expect, it } from 'vitest'
import * as avltree from '../src/index.js'
import { type AvlVerifyFailReason } from '../src/index.js'

describe('0.5.0 public surface', () => {
  // 0.5.0 introduced BatchAVLVerifier and AvlVerifyFailReason; those remain
  // in the current surface. The 0.5.0 neighbor-reporting lookups and their
  // types moved to @dagsocial/avltree in 0.7.0 — see
  // public-surface-0.7.test.ts for the current exact set.
  it('exports BatchAVLVerifier and AvlVerifyFailReason', () => {
    expect(typeof avltree.BatchAVLVerifier).toBe('function')
    // Compile-time probe on the type: the annotation is the assertion.
    const reason: AvlVerifyFailReason = 'digest-mismatch'
    expect(reason).toBe('digest-mismatch')
  })
})
