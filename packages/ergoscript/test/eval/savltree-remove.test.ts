/**
 * SAvlTree.remove (100:14) — Tier-2 verification op handler (JVM-canonical, F4).
 *
 * Source: CErgoTreeEvaluator.scala:230-254 (JVM), savltree.rs:279-337 (sigma-rust ref).
 *
 * Failure model (JVM-canonical, F4) — remove NEVER throws:
 *   - !remove_allowed → isRemoveAllowed Fixed(15) charged, return `Option None`.
 *   - verifier construct fail → verifier poisoned; per-op results discarded (cfor);
 *     digest None → `Option None` (NO throw — pre-F4 ergots threw; sigma-rust fork).
 *   - any per-op Remove fail → result discarded (cfor continues); digest None → `Option None`.
 *   - full success → `Some(AvlTree(new_digest))`.
 *
 * Pre-F4 ergots threw on both construct-fail and per-op-fail, matching sigma-rust's
 * `?`-on-construct fork (savltree.rs:316,322). F4 fixes this to match JVM; ergots leads.
 * The 'avl-tree-proof-failed' code is no longer reachable from remove.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

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

describe('SAvlTree.remove — construct-fail model (JVM: never-throws → None)', () => {
  it('returns None (not throw) when proof bytes are zeroed (construct fail)', () => {
    // JVM-canonical (F4): remove NEVER throws. Construct failure poisons the verifier;
    // per-op results are discarded (cfor, no break); digest() → None → None.
    // Pre-F4 ergots threw 'avl-tree-proof-failed' here — that was the sigma-rust fork.
    //
    // remove_success_1_key uses a length-100 proof: "0e64 03 85ab460a..."
    // Cost decomposition for zeroed-proof case (treeHeight=2, 1 op, proof 100 B):
    //   envelope(19) + isRemoveAllowed(15) + createVerifier(110+20×2=150)
    //   + RemoveAvlTree(100+15×2=130)×1 + digest_unconditional(15) = 329
    //   (no updateDigest(40) — construct fail → None before success path)
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
    const result = evaluateWith(tree, ctx)
    expect(result).toEqual({ kind: 'Option', elem: { tag: 'SAvlTree' }, value: null })
    expect(ctx.jitCost).toBe(329)
  })
})
