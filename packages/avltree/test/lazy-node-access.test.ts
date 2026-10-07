/**
 * Lazy-node-access invariant (0.7.0) — pins the engine's property that the
 * prover reads `left` / `right` of a node only when descending into or
 * labeling that node. A caller may back the tree with nodes whose `left` /
 * `right` are getters that materialize on first access, provided unvisited
 * siblings carry a precomputed label (via `labelCache` or a `LabelNode`
 * stub). All public lookups, neighbor lookups, inserts and removes produce
 * byte-identical proofs and digests to a fully loaded tree.
 *
 * The Variant-A loader presets `labelCache` from the stored row's key and
 * puts `left` / `right` behind getters, as a downstream lazy-loading store
 * (e.g. `@dagsocial/avltree`) does.
 *
 * Not Ergo consensus — the invariant exists so a downstream TS verifier of
 * its own (e.g. a lazy-loading store) can share the engine. See
 * facts/avltree.md § Lazy-node access invariant.
 */

import { describe, it, expect } from 'vitest'
import {
  BatchAVLProver,
  deserializeNode,
  label,
  newInternal,
  serializeNode,
} from '../src/index.js'
import type { AvlNode, InternalNode } from '../src/node.js'
import { createHash } from 'node:crypto'

const KL = 65
const CFG = { keyLength: KL, valueLengthOpt: null }
const N = 2000 // enough to produce a tree of height ~15

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

function keyOf(i: number): Uint8Array {
  const h = createHash('blake2b512').update(`k${i}`).digest()
  const k = new Uint8Array(KL)
  k.set(h.subarray(0, 64), 1)
  k[0] = 1
  return k
}

function buildFullTree(): {
  prover: BatchAVLProver
  keys: Uint8Array[]
  rows: Map<string, Uint8Array>
  rootLabel: Uint8Array
  height: number
} {
  const prover = new BatchAVLProver(KL, null)
  const keys: Uint8Array[] = []
  for (let i = 0; i < N; i++) {
    const k = keyOf(i)
    keys.push(k)
    const r = prover.performOneOperation({
      tag: 'Insert',
      key: k,
      value: new Uint8Array(40).fill(i & 0xff),
    })
    if (!r.success) throw new Error(`seed insert ${i} failed`)
  }
  prover.generateProof() // close the cycle; move oldTopNode forward
  const rootLabel = label(prover.root)
  const height = prover.height

  // Serialize every node, keyed by its label — the row store Notis's loader
  // reads from.
  const rows = new Map<string, Uint8Array>()
  const walk = (n: AvlNode): void => {
    rows.set(hex(label(n)), serializeNode(n, CFG))
    if (n.kind === 'internal') {
      walk(n.left)
      walk(n.right)
    }
  }
  walk(prover.root)
  return { prover, keys, rows, rootLabel, height }
}

/**
 * The probe's Variant A loader: for a leaf, deserialize + preset labelCache
 * and return. For an internal node, deserialize to read its key / balance /
 * children's labels, then return a fresh object whose `left` / `right` are
 * getters that call `load` on first access. Each call to the getter counts
 * as one row load.
 */
function makeLazyLoader(rows: Map<string, Uint8Array>): {
  load: (lab: Uint8Array) => AvlNode
  loads: () => number
  reset: () => void
} {
  let count = 0
  const load = (lab: Uint8Array): AvlNode => {
    count++
    const row = rows.get(hex(lab))
    if (!row) throw new Error(`row for ${hex(lab).slice(0, 16)}… not found`)
    const n = deserializeNode(row, CFG)
    if (n.kind === 'leaf') {
      n.labelCache = new Uint8Array(lab)
      return n
    }
    if (n.kind === 'label') return n
    const ll = label(n.left)
    const rl = label(n.right)
    let L: AvlNode | null = null
    let R: AvlNode | null = null
    const lazy: InternalNode = {
      kind: 'internal',
      key: n.key,
      balance: n.balance,
      labelCache: new Uint8Array(lab),
      get left(): AvlNode {
        return (L ??= load(ll))
      },
      get right(): AvlNode {
        return (R ??= load(rl))
      },
    } as InternalNode
    return lazy
  }
  return { load, loads: () => count, reset: () => { count = 0 } }
}

/** The reference loader: a plain, fully-materialized copy of the tree. */
function makeEagerCopy(rows: Map<string, Uint8Array>): (lab: Uint8Array) => AvlNode {
  const copy = (lab: Uint8Array): AvlNode => {
    const row = rows.get(hex(lab))
    if (!row) throw new Error(`row for ${hex(lab).slice(0, 16)}… not found`)
    const n = deserializeNode(row, CFG)
    if (n.kind !== 'internal') return n
    return newInternal(copy(label(n.left)), copy(label(n.right)), n.balance, n.key)
  }
  return copy
}

interface Case {
  name: string
  run: (prover: BatchAVLProver) => void
}

function makeCases(keys: Uint8Array[]): Case[] {
  const sorted = [...keys].sort((a, b) => Buffer.compare(a, b))
  const absent = keyOf(N + 7)
  return [
    {
      name: 'one present key — Lookup',
      run: (p) => {
        const r = p.performOneOperation({ tag: 'Lookup', key: keys[1234 % N]! })
        if (!r.success) throw new Error('present Lookup failed')
      },
    },
    {
      name: 'one absent key — Lookup',
      run: (p) => {
        const r = p.performOneOperation({ tag: 'Lookup', key: absent })
        if (!r.success) throw new Error('absent Lookup failed')
      },
    },
    {
      name: '513 Lookups in key order (a full page)',
      run: (p) => {
        for (let i = 0; i < 513; i++) {
          const r = p.performOneOperation({ tag: 'Lookup', key: sorted[(100 + i) % N]! })
          if (!r.success) throw new Error('page Lookup failed')
        }
      },
    },
    {
      name: 'insert + remove',
      run: (p) => {
        const i = p.performOneOperation({
          tag: 'Insert',
          key: absent,
          value: new Uint8Array(40),
        })
        if (!i.success) throw new Error('insert failed')
        const r = p.performOneOperation({ tag: 'Remove', key: keys[77 % N]! })
        if (!r.success) throw new Error('remove failed')
      },
    },
  ]
}

describe('lazy-node-access invariant — proof + digest byte equality', () => {
  const built = buildFullTree()
  const { keys, rows, rootLabel, height } = built
  const cases = makeCases(keys)
  const eagerCopy = makeEagerCopy(rows)

  for (const c of cases) {
    it(`${c.name}: lazy prover produces byte-identical proof and digest`, () => {
      // Lazy prover: left/right are getters.
      const lazy = new BatchAVLProver(KL, null)
      const loader = makeLazyLoader(rows)
      lazy.restoreRoot(loader.load(rootLabel), height)
      c.run(lazy)
      const lazyProof = lazy.generateProof()
      const lazyDigest = lazy.digest()

      // Reference prover: a fully-materialized copy of the same tree.
      const eager = new BatchAVLProver(KL, null)
      eager.restoreRoot(eagerCopy(rootLabel), height)
      c.run(eager)
      const eagerProof = eager.generateProof()
      const eagerDigest = eager.digest()

      expect(lazyProof).toEqual(eagerProof)
      expect(lazyDigest).toEqual(eagerDigest)
      // Load count is bounded. A lazy prover materializes a node only when
      // the engine reads its `left` or `right`. If the invariant broke and
      // the engine started reading unvisited siblings' children, this would
      // explode toward `rows.size`.
      expect(loader.loads()).toBeLessThan(rows.size)
    })
  }

  it('a single-key operation materializes at most O(height) rows', () => {
    // The tight invariant check. If the engine ever reaches a sibling's
    // `left` or `right`, loads would double per level.
    const singleKeyBound = height * 2 + 10
    for (const name of [
      'one present key — Lookup',
      'one absent key — Lookup',
    ]) {
      const c = cases.find((c) => c.name === name)!
      const lazy = new BatchAVLProver(KL, null)
      const loader = makeLazyLoader(rows)
      lazy.restoreRoot(loader.load(rootLabel), height)
      c.run(lazy)
      lazy.generateProof()
      expect(loader.loads(), name).toBeLessThanOrEqual(singleKeyBound)
    }
  })
})
