/**
 * Layer C3.a — Byte-level mutation testing for the TreeLookup arm.
 *
 * For each success-path fixture, mutate the inline `Const(Coll[Byte], …)`
 * proof bytes (the LARGEST mutable region in a TreeLookup tree, by far —
 * proof bytes are 100-500 bytes; key bytes are 1 byte). Per `isKillStandard`:
 *   - baseline ok + mutated throws → kill (verifier rejects mutated proof
 *                                          → 'avl-tree-proof-failed')
 *   - baseline ok + mutated ok     → kill iff values differ (proof bytes
 *                                     encode the entire AVL+ path tree
 *                                     reconstruction; changing them either
 *                                     fails verification or returns a
 *                                     different lookup outcome)
 *
 * Why proof-only:
 *
 *   - Proof is the LARGEST mutable surface (≥50 bytes for a 10-leaf tree;
 *     a single-leaf tree is shorter but still tens of bytes).
 *   - Most byte flips trip the verifier's proof-decode (`parseProofPackedTree`)
 *     at the first invalid token byte OR cause a digest mismatch downstream.
 *     Either way → throw → kill via standard rule.
 *   - The key region is 1 byte; mutating it would lookup a DIFFERENT key
 *     against the SAME proof. For most fixtures the proof is constructed for
 *     a specific key, so a different key would mismatch the proof
 *     reconstruction → still kills, but the mutation surface is tiny (3
 *     XOR patterns × 1 byte = 3 mutations only).
 *   - The digest is wrapped INSIDE the AvlTree Const (not a SColl(SByte)
 *     Const), so `findInlineByteColls` doesn't surface it. Skipping (the
 *     proof region provides ample mutation surface).
 *
 * Index assignment in `findInlineByteColls(tree.body)`:
 *   The TreeLookup body has 3 child Expr nodes in order: tree (AvlTree Const,
 *   NOT a Coll[Byte] Const), key (Coll[Byte] Const, idx 0), proof
 *   (Coll[Byte] Const, idx 1). So the proof is at collIndex = 1.
 *
 * Expected behavior by entry (4 success fixtures):
 *
 *   - tl_found_in_10_leaf_low_key, tl_found_in_10_leaf_boundary_key:
 *     Mutating the proof either makes proof-decode fail OR produces a
 *     verifier-state where the lookup returns a different value/None. Both
 *     kill via standard rule.
 *
 *   - tl_absent_in_10_leaf: Same. Most mutations break proof-decode (kill via
 *     throw); some may flip "key absent" → "key present at unrelated value"
 *     (kill via value-differ).
 *
 *   - tl_single_leaf_found: Same. Single-leaf trees have shorter proofs
 *     (fewer mutation positions) but each byte is highly load-bearing.
 *
 * Skipped fixtures:
 *   - error entries (`tl_throw_*`): no success-path baseline — explicitly
 *     filtered.
 *
 * Threshold: ≥ 0.90 per entry (aggregate fallback accepted).
 *
 * Source: ergotree-interpreter/src/eval/tree_lookup.rs:20-65
 * Pattern: create-avl-tree-mutation.test.ts (shared harness in
 *          test/_helpers/mutation-harness.ts).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { hexToBytes } from '../_helpers'
import {
  runMutationLoop,
  locateInlineCollRegion,
  DEFAULT_KILL_THRESHOLD,
} from '../_helpers/mutation-harness'

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code?: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'tree-lookup.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

describe('TreeLookup mutation testing (Layer C3.a)', () => {
  // Skip error entries (no success-path baseline).
  const entries = fixture.entries.filter(
    (e) => e.expected_error_code === null || e.expected_error_code === undefined,
  )
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on proof-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)

      // TreeLookup body has 2 inline Coll[Byte] Consts in body order:
      //   collIndex=0 → key  (1 byte)
      //   collIndex=1 → proof (the largest mutable surface)
      const region = locateInlineCollRegion(treeBytes, tree, 1)

      const result = runMutationLoop({
        treeBytes,
        region: { start: region.start, end: region.end },
        optsJson: entry.opts_json,
      })

      // eslint-disable-next-line no-console
      console.log(
        `[mutation] tree_lookup.${entry.name}#proof: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `inputLen=${region.length} inputStart=${region.start}`,
      )

      aggKilled += result.killed
      aggTotal += result.total

      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`TreeLookup: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG tree_lookup: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
