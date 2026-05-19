/**
 * SAvlTree.getMany (100:11) — Tier-2 verification op handler.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:152-212 — GET_MANY_EVAL_FN.
 *
 * Failure model:
 *   - verifier construct fail (line 184 `?`) → throw 'avl-tree-proof-failed'
 *   - per-key Lookup Err (line 200-203) → throw same code
 *   - per-key Lookup Ok None → element `Option None`
 *   - per-key Lookup Ok Some → element `Some(Coll[Byte])`
 *
 * Verifier returns `Coll[Option[Coll[Byte]]]`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface GetManyEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface GetManyFixture {
  corpus: string
  entries: GetManyEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-get-many.json')
const fixture: GetManyFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.getMany — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('SAvlTree.getMany — throw paths', () => {
  it('throws avl-tree-proof-failed when proof bytes are zeroed (construct fail)', () => {
    // Reuse the get_many_all_absent fixture (its proof prefix is the same
    // "0e55..." pattern as the get/contains fixtures).
    const sample = fixture.entries.find((e) => e.name === 'get_many_all_absent')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')

    const goodHex = sample.tree_bytes_hex
    const proofTagIdx = goodHex.indexOf('0e55030d3b')
    if (proofTagIdx < 0) throw new Error('test setup: proof prefix not found')
    const proofBodyStart = proofTagIdx + 4
    const proofBodyLen = 85 * 2
    const mutated =
      goodHex.slice(0, proofBodyStart) +
      '00'.repeat(85) +
      goodHex.slice(proofBodyStart + proofBodyLen)

    const tree = parseTree(hexToBytes(mutated))
    const ctx = makeContext({})
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('avl-tree-proof-failed')
  })
})
