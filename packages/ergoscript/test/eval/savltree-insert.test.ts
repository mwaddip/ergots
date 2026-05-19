/**
 * SAvlTree.insert (100:12) — Tier-2 verification op handler.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:214-277 — INSERT_EVAL_FN.
 *
 * Failure model:
 *   - !insert_allowed (line 218-220) → `Option None` BEFORE any avltree call
 *   - verifier construct fail (line 251 `?`) → throw 'avl-tree-proof-failed'
 *   - V<3 per-op fail (line 263-267) → throw same code
 *   - V3+ per-op fail (line 260-261 `break`) → `Option None` via poisoned digest
 *   - full success → `Some(AvlTree(new_digest))`
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface InsertEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface InsertFixture {
  corpus: string
  entries: InsertEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-insert.json')
const fixture: InsertFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.insert — fixture-driven', () => {
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

describe('SAvlTree.insert — throw paths', () => {
  it('throws avl-tree-proof-failed when proof bytes are zeroed (construct fail) — V0 default', () => {
    // Reuse insert_success_1_entry — the proof Const is "0e08 02 00ff 00000000"
    // (tag 0e = SColl Byte, len 0x08 = 8, then 8 bytes). Zero the 8 proof
    // body bytes to force a construct-time failure (the root header byte 0x02
    // tells reconstruct_tree to expect a packed-tree InternalWithLabel; zeroing
    // it yields a LabelOnly node with no label — fails the start-digest match).
    const sample = fixture.entries.find((e) => e.name === 'insert_success_1_entry')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')
    const goodHex = sample.tree_bytes_hex
    // Proof Const tag = "0e08" near end. Find it as the last occurrence.
    const tagIdx = goodHex.lastIndexOf('0e08')
    if (tagIdx < 0) throw new Error('test setup: proof tag not found')
    const proofBodyStart = tagIdx + 4
    const proofBodyLen = 8 * 2
    const mutated =
      goodHex.slice(0, proofBodyStart) +
      '00'.repeat(8) +
      goodHex.slice(proofBodyStart + proofBodyLen)
    const tree = parseTree(hexToBytes(mutated))
    const ctx = makeContext({})
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('avl-tree-proof-failed')
  })

  it('V3+ partial-success path: insert with insert_allowed and treeVersion=3 — fixture full-success still works', () => {
    // This test confirms the V3 branch is NOT broken by the survey-noted V3
    // partial-success semantics: a full-success input under V3 still returns
    // Some(AvlTree). The break path (per-op fail under V3) isn't exercised
    // here because we lack a "V3-per-op-fail" fixture (would require fixture-
    // gen to set treeVersion=3, and the V3 break returns Option None which
    // is reachable only via a deliberately-bad proof + insert_allowed).
    //
    // The point of this test: confirm the V3 path doesn't accidentally throw
    // on full-success input (i.e., we read `ctx.treeVersion` correctly and
    // pass through to the verifier).
    const sample = fixture.entries.find((e) => e.name === 'insert_success_1_entry')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')
    const tree = parseTree(hexToBytes(sample.tree_bytes_hex))
    // Force treeVersion=3 even if the tree's header version is lower; the
    // V3+ break is gated by ctx.treeVersion which evaluate() seeds from
    // tree.header.version when not explicitly set.
    const ctx = makeContext({ treeVersion: 3 })
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual(hydrateSValue(sample.expected_value_json))
  })
})
