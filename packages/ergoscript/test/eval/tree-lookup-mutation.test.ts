/**
 * TreeLookup — mutation suite RETIRED (F4 epilogue), replaced by
 * operand-mutation reject pins.
 *
 * The Layer C3.a kill-rate loop (proof-byte XOR mutations vs an evaluating
 * baseline) is meaningless for an arm that throws unconditionally: the JVM
 * has NO eval override for TreeLookup (trees.scala:1322-1338; default
 * `Value.eval` → `sys.error`, values.scala:102), so the ergots arm now
 * throws `'unsupported-eval-node'` before reading any operand. An
 * always-throwing arm has NO mutable behavior — every mutant is
 * behavior-identical to the baseline, so a kill-rate denominator does not
 * exist. This mirrors the `contains_key_absent` precedent in
 * savltree-mutation.test.ts (false-baseline entries excluded from kill
 * loops because failure collapses to the baseline value — 0% kill is not
 * a gap).
 *
 * What replaces it: plain reject pins over MUTATED operand bytes. For each
 * old success-path fixture we XOR one byte inside the inline proof Const
 * (content-only flip — the Coll length prefix is untouched so the tree
 * still parses) and assert the arm STILL throws `'unsupported-eval-node'`.
 * That pins exactly the property the kill loop can no longer express:
 * the reject is operand-independent.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes } from '../_helpers'
import { locateInlineCollRegion } from '../_helpers/mutation-harness'

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_error_code?: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'tree-lookup.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

describe('TreeLookup — reject is operand-independent (mutation pins)', () => {
  // The four old success-shape entries carry real 10-leaf / single-leaf
  // proofs — the largest operand surface. Mutating the proof must NOT
  // change the outcome: the arm throws before reading it.
  const proofCarrying = fixture.entries.filter((e) =>
    [
      'tl_found_in_10_leaf_low_key',
      'tl_absent_in_10_leaf',
      'tl_single_leaf_found',
      'tl_found_in_10_leaf_boundary_key',
    ].includes(e.name),
  )

  it('covers the four proof-carrying fixture shapes', () => {
    expect(proofCarrying).toHaveLength(4)
  })

  for (const entry of proofCarrying) {
    it(`${entry.name}: proof-byte mutation still rejects 'unsupported-eval-node'`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)

      // TreeLookup body order: tree (AvlTree Const), key (Coll[Byte] Const,
      // collIndex 0), proof (Coll[Byte] Const, collIndex 1).
      const region = locateInlineCollRegion(treeBytes, tree, 1)

      // Content-only flip in the middle of the proof region — the length
      // prefix is untouched, so the tree still parses.
      const mutated = Uint8Array.from(treeBytes)
      const pos = region.start + Math.floor(region.length / 2)
      mutated[pos] = (mutated[pos] ?? 0) ^ 0xff

      const mutatedTree = parseTree(mutated)
      const ctx = makeContext({ ...entry.opts_json })
      const err = captureEvalError(() => evaluateWith(mutatedTree, ctx))
      expect(err.code).toBe('unsupported-eval-node')
    })
  }
})
