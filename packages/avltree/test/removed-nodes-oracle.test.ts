import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { label, type AvlNode } from '../src/node.js'
import type { Operation } from '../src/index.js'

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// Deterministic PRNG (mulberry32) — seeds pinned, runs reproducible.
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const collectLabels = (node: AvlNode, out = new Set<string>()): Set<string> => {
  out.add(bytesToHex(label(node)))
  if (node.kind === 'internal') {
    collectLabels(node.left, out)
    collectLabels(node.right, out)
  }
  return out
}

const setDiff = (a: Set<string>, b: Set<string>): string[] =>
  [...a].filter((x) => !b.has(x)).sort()

describe('removedNodes() equals the brute-force old−new label set difference', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it(`seed ${seed}: 4 cycles of randomized ops (with failing ops interleaved)`, () => {
      const rnd = mulberry32(seed)
      const key = (n: number) => {
        const a = new Uint8Array(32)
        a[0] = 1
        a[30] = (n >> 8) & 0xff
        a[31] = n & 0xff
        return a
      }
      const val = (n: number) => {
        const a = new Uint8Array(8)
        a[6] = (n >> 8) & 0xff
        a[7] = n & 0xff
        return a
      }
      const prover = new BatchAVLProver(32, 8)
      const live = new Set<number>()

      for (let cycle = 0; cycle < 4; cycle++) {
        // F8a: capture the pre-cycle root INDEPENDENTLY of prover.oldTopNode.
        const preRoot = prover.root
        const opCount = 5 + Math.floor(rnd() * 20)
        for (let i = 0; i < opCount; i++) {
          const roll = rnd()
          const liveArr = [...live]
          const pick = () => liveArr[Math.floor(rnd() * liveArr.length)]!
          let op: Operation
          let expectSuccess = true
          if (roll < 0.35 || live.size === 0) {
            const n = Math.floor(rnd() * 5000)
            op = { tag: 'Insert', key: key(n), value: val(n) }
            expectSuccess = !live.has(n)
            if (expectSuccess) live.add(n)
          } else if (roll < 0.55) {
            const n = pick()
            op = { tag: 'Remove', key: key(n) }
            live.delete(n)
          } else if (roll < 0.7) {
            const n = pick()
            op = { tag: 'Update', key: key(n), value: val(Math.floor(rnd() * 5000)) }
          } else if (roll < 0.8) {
            op = { tag: 'Lookup', key: key(pick()) }
          } else if (roll < 0.9) {
            // scripted FAILURE: Remove on an absent key
            op = { tag: 'Remove', key: key(9999) }
            expectSuccess = false
          } else {
            const n = Math.floor(rnd() * 5000)
            op = { tag: 'InsertOrUpdate', key: key(n), value: val(n) }
            live.add(n)
          }
          expect(prover.performOneOperation(op).success).toBe(expectSuccess)
        }

        const oracle = setDiff(collectLabels(preRoot), collectLabels(prover.root))
        const actual = prover.removedNodes().map((n) => bytesToHex(label(n))).sort()
        expect(actual).toEqual(oracle)
        prover.generateProof()
      }
    })
  }
})
