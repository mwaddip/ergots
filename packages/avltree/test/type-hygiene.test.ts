import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import type { AvlNode, InternalNode } from '../src/node.js'
import type { VersionedAVLStorage } from '../src/versioned-storage.js'

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

describe('type hygiene probes (C2 + C3)', () => {
  it('rollback returns a typed AvlNode (C2)', () => {
    // Compile-time probe: pre-C2 `root` is `unknown` and the annotation below
    // fails tsc; post-C2 it compiles.
    const probe = (storage: VersionedAVLStorage): AvlNode => {
      const [root] = storage.rollback(new Uint8Array(33))
      return root
    }
    expect(typeof probe).toBe('function')
  })

  it('InternalNode children/balance are readonly (C3)', () => {
    const probe = (node: InternalNode, other: InternalNode): void => {
      // @ts-expect-error left is readonly (C3)
      node.left = other
      // @ts-expect-error right is readonly (C3)
      node.right = other
      // @ts-expect-error balance is readonly (C3)
      node.balance = 0
    }
    expect(typeof probe).toBe('function')
  })
})

describe('type hygiene probes (BatchAVLProver getters)', () => {
  it('root/height/oldTopNode are get-only — restoreRoot is the one write path', () => {
    const probe = (prover: BatchAVLProver, other: AvlNode): void => {
      // @ts-expect-error root has no setter — restoreRoot(root, height) is the sanctioned write path
      prover.root = other
      // @ts-expect-error height has no setter — restoreRoot(root, height) is the sanctioned write path
      prover.height = 1
      // @ts-expect-error oldTopNode has no setter — restoreRoot(root, height) is the sanctioned write path
      prover.oldTopNode = other
    }
    expect(typeof probe).toBe('function')
  })
})
