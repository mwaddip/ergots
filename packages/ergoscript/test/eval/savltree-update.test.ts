/**
 * SAvlTree.update (100:13) — Tier-2 verification op handler.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:383-439 — UPDATE_EVAL_FN.
 *
 * Failure model (NOTE: diverges from `insert` — no V<3/V3+ split):
 *   - !update_allowed (line 387-389) → `Option None` BEFORE any avltree call
 *   - verifier construct fail (line 420 `?`) → throw 'avl-tree-proof-failed'
 *   - per-op fail (line 422-431 UNCONDITIONAL `break`) → `Option None` via
 *     poisoned digest (no V<3 throw branch)
 *   - full success → `Some(AvlTree(new_digest))`
 *
 * Source-read confirmation: line 429 is `break;` without a tree_version
 * check. This is a survey divergence — survey said V<3 throws like insert;
 * sigma-rust shows update always breaks.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface UpdateEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface UpdateFixture {
  corpus: string
  entries: UpdateEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-update.json')
const fixture: UpdateFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.update — fixture-driven', () => {
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

describe('SAvlTree.update — throw paths', () => {
  it('throws avl-tree-proof-failed when proof bytes are zeroed (construct fail)', () => {
    // update_success_1_entry has a proof "0e55 03 0d3b ..." (length-85 proof).
    const sample = fixture.entries.find((e) => e.name === 'update_success_1_entry')
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
