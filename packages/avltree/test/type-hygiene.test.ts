import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import type { AvlNode } from '../src/node.js'

// Compile-time probes: these ASSIGNMENTS are the assertions. Pre-C8 they fail
// `npx tsc --noEmit --project packages/avltree/tsconfig.json` (null not
// assignable); post-C8 they compile. The it-block only keeps vitest happy.
describe('type hygiene probes (C8)', () => {
  it('prover root/oldTopNode/digest are non-nullable', () => {
    const prover = new BatchAVLProver(32, null)
    const root: AvlNode = prover.root
    const top: AvlNode = prover.oldTopNode
    const digest: Uint8Array = prover.digest()
    expect(root).toBeDefined()
    expect(top).toBeDefined()
    expect(digest.length).toBe(33)
  })
})
