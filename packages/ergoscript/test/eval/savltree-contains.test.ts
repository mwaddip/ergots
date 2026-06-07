/**
 * SAvlTree.contains (100:9) — Tier-2 verification op handler.
 *
 * Fixture-driven success/absent/mutated suite + a TS-only hand-crafted case
 * that pins the construct-failure → false behavior (JVM-canonical, F4).
 *
 * Source: CErgoTreeEvaluator.scala:67-90 (JVM-canonical, F4).
 *         ergotree-interpreter/src/eval/savltree.rs:339-381 (sigma-rust diverges:
 *         keeps the construct `?`-throw; eni savltree.rs:361).
 *
 * JVM failure model (F4-canonical):
 *   - verifier construct failure → false (scorex swallows, topNode = None;
 *     every subsequent op returns Failure → maps to false)
 *   - per-op Lookup failure → false
 *   - per-op result None → false (key absent)
 *   - per-op result Some(_) → true (key present)
 *
 * contains NEVER throws; all failure paths converge on false.
 * `contains_proof_mutated` (per-op fail) → false.
 * The construct-failure case is hand-crafted (mutation below) and also → false.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

interface ContainsEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface ContainsFixture {
  corpus: string
  entries: ContainsEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-contains.json')
const fixture: ContainsFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.contains — fixture-driven', () => {
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

describe('SAvlTree.contains — construct-failure → false (JVM-canonical, F4)', () => {
  it('construct-failure returns false (JVM: no throw path exists; scorex swallows reconstruction errors)', () => {
    // Take the success fixture, zero out the proof's packed-tree payload so the
    // verifier's reconstruct_tree pass fails structurally. Uses the same
    // hex-mutation approach as the get/getMany throw tests for consistency.
    const present = fixture.entries.find((e) => e.name === 'contains_key_present')
    if (present === undefined) throw new Error('test setup: missing fixture entry')

    // Substitute the bytes after the proof Const header "0e55" with all-zeros
    // (preserving length). 0e = SColl Byte tag, 55 = VLQ length 85.
    // The proof spans 85 bytes after the "0e55" tag+length pair. Zeroing
    // those 85 bytes forces a construct failure inside BatchAVLVerifier.new().
    const goodHex = present.tree_bytes_hex
    const proofTagIdx = goodHex.indexOf('0e55030d3b')
    if (proofTagIdx < 0) throw new Error('test setup: proof prefix not found')
    const proofBodyStart = proofTagIdx + 4 // skip "0e55"
    const proofBodyLen = 85 * 2 // 85 bytes * 2 hex chars
    const mutated =
      goodHex.slice(0, proofBodyStart) +
      '00'.repeat(85) +
      goodHex.slice(proofBodyStart + proofBodyLen)

    const tree = parseTree(hexToBytes(mutated))
    const ctx = makeContext({})
    const value = evaluateWith(tree, ctx)
    // JVM CErgoTreeEvaluator.scala:84-90 — Lookup Failure → false; scorex
    // swallows construct failure (no construct-throw path exists). Pre-F4
    // ergots threw 'avl-tree-proof-failed' here: that was the sigma-rust
    // `?`-on-construct fork (eni savltree.rs:361 still has it).
    expect(value).toEqual({ kind: 'Boolean', value: false })
    // Cost is outcome-independent — same as the success path (charges precede
    // construction and lookup; failure does not reduce them):
    //   envelope   = 19   (dispatcher + Const-arg eval overhead)
    //   createVerifier(85) = 110 + 20 * (Math.trunc(84/64)+1) = 110 + 20*2 = 150
    //   LookupAvlTree(h=2) = 40 + 10 * (Math.trunc(1/1)+1)   = 40 + 10*2  = 60
    //   total = 19 + 150 + 60 = 229
    // Matches expected_cost in the contains_key_present fixture entry.
    expect(ctx.jitCost).toBe(229)
  })
})
