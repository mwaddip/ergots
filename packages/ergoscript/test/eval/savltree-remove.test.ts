/**
 * SAvlTree.remove (100:14) — Tier-2 verification op handler.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:279-337 — REMOVE_EVAL_FN.
 *
 * Failure model (NO V3+ break — only modify-style handler without it):
 *   - !remove_allowed (line 283-285) → `Option None` BEFORE any avltree call
 *   - verifier construct fail (line 316 `?`) → throw 'avl-tree-proof-failed'
 *   - per-op Remove fail (line 318-326 always-throw) → throw same code
 *   - full success → `Some(AvlTree(new_digest))`
 *
 * Confirmed: line 322 is unconditional `return Err(...)`. No ctx.tree_version
 * branching anywhere in remove.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface RemoveEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface RemoveFixture {
  corpus: string
  entries: RemoveEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-remove.json')
const fixture: RemoveFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.remove — fixture-driven', () => {
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

describe('SAvlTree.remove — throw paths', () => {
  it('throws avl-tree-proof-failed when proof bytes are zeroed (construct fail)', () => {
    // remove_success_1_key uses a length-100 proof: "0e64 03 85ab460a..."
    const sample = fixture.entries.find((e) => e.name === 'remove_success_1_key')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')
    const goodHex = sample.tree_bytes_hex
    const proofTagIdx = goodHex.indexOf('0e640385ab')
    if (proofTagIdx < 0) throw new Error('test setup: proof prefix not found')
    const proofBodyStart = proofTagIdx + 4
    const proofBodyLen = 100 * 2
    const mutated =
      goodHex.slice(0, proofBodyStart) +
      '00'.repeat(100) +
      goodHex.slice(proofBodyStart + proofBodyLen)
    const tree = parseTree(hexToBytes(mutated))
    const ctx = makeContext({})
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('avl-tree-proof-failed')
  })
})
