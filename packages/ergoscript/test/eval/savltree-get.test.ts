/**
 * SAvlTree.get (100:10) — Tier-2 verification op handler.
 *
 * Fixture-driven present/absent suite + a TS-only throw test that asserts
 * construct-failure raises EvalError 'avl-tree-proof-failed'.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:104-150 — GET_EVAL_FN.
 *
 * Failure model:
 *   - verifier construct fail (line 136 `?`) → throw
 *   - per-op Lookup Err (line 145-148 `return Err(...)`) → throw
 *   - Ok None → `Option None`
 *   - Ok Some(bytes) → `Some(Coll[Byte])`
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface GetEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface GetFixture {
  corpus: string
  entries: GetEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-get.json')
const fixture: GetFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.get — fixture-driven', () => {
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

describe('SAvlTree.get — throw paths', () => {
  it('throws avl-tree-proof-failed when proof bytes are zeroed (construct fail)', () => {
    // Reuse the get_key_present fixture's hex and zero out the proof payload
    // so the verifier's reconstruct_tree pass underflows / mismatches.
    // The hex layout: ...0e55<85 bytes of proof>02... — replace the 85
    // bytes after "0e55" with all zeros to force a construct-time failure.
    const present = fixture.entries.find((e) => e.name === 'get_key_present')
    if (present === undefined) throw new Error('test setup: missing get_key_present fixture')

    const goodHex = present.tree_bytes_hex
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
