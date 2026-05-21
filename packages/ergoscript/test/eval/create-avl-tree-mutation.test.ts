/**
 * Layer C3.a — Byte-level mutation testing for the CreateAvlTree arm.
 *
 * For each success-path fixture, mutate the 33-byte digest payload of the
 * inline `Const(Coll[Byte], …)` digest input. Per `isKillStandard`:
 *   - baseline ok + mutated throws  → kill (length check rejected; or, in
 *                                     the throw fixture, kind/length flips
 *                                     diverging into a different error code)
 *   - baseline ok + mutated ok      → kill iff values differ (changed digest
 *                                     bytes produce a different
 *                                     AvlTreeData.digest, hence different
 *                                     SValue equality)
 *
 * Why digest-only:
 *
 *   - The digest is 33 bytes — the largest mutable region. Almost all byte
 *     flips change the resulting AvlTreeData.digest field, killing via
 *     value-differ.
 *
 *   - Flags byte (1 byte) has STRUCTURAL EQUIVALENCE CLASSES due to the
 *     `& 0x07` canonicalization. A 0x01 ↔ 0x09 flip (bit 3) is invisible
 *     to the handler — both round-trip to canonical 0x01. Mutating this
 *     1-byte region adds noise and lowers per-entry kill rate, so we skip.
 *
 *   - KeyLength / valueLength are VLQ ZigZag — variable-length encoding, so
 *     locating the exact byte region by `findInlineByteColls` doesn't apply.
 *     Direct VLQ byte-level mutation would need a separate locator. Skipped
 *     for simplicity; the digest region provides ample mutation surface.
 *
 *   - The bit-cast invariant (`>>> 0`) is covered by the oracle fixture
 *     `cat_negative_keylength` (Layer C1), not by mutation testing.
 *
 * Expected behaviour by entry:
 *
 *   - cat_flags_0_no_vlen / cat_flags_7_vlen_5 / cat_flags_3_vlen_0 :
 *     Mutating the 33-byte digest produces a different stored
 *     `AvlTreeData.digest` → value-differ kill.
 *
 *   - cat_valuelen_i32_max / cat_negative_keylength / cat_large_keylength /
 *     cat_flags_FF_canonicalize : Same as above — digest bytes are the
 *     mutation region; the result `AvlTreeData` value differs.
 *
 * Skipped fixtures:
 *   - error entries (`cat_throw_*`): no success-path baseline — explicitly
 *     filtered.
 *
 * Threshold: ≥ 0.90 per entry (aggregate fallback accepted). For digest
 * mutation, kill rate should approach 1.0 because every byte flip changes
 * the AvlTreeData.digest field.
 *
 * Source: ergotree-interpreter/src/eval/create_avl_tree.rs:15-41
 * Pattern: multiply-group-mutation.test.ts (shared harness in
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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'create-avl-tree.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

describe('CreateAvlTree mutation testing (Layer C3.a)', () => {
  // Skip error entries (no success-path baseline).
  const entries = fixture.entries.filter(
    (e) => e.expected_error_code === null || e.expected_error_code === undefined,
  )
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on digest-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)

      // CreateAvlTree trees carry exactly one inline Coll[Byte] (the digest).
      const region = locateInlineCollRegion(treeBytes, tree, 0)

      const result = runMutationLoop({
        treeBytes,
        region: { start: region.start, end: region.end },
        optsJson: entry.opts_json,
      })

      // eslint-disable-next-line no-console
      console.log(
        `[mutation] create_avl_tree.${entry.name}#digest: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `inputLen=${region.length} inputStart=${region.start}`,
      )

      aggKilled += result.killed
      aggTotal += result.total

      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`CreateAvlTree: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG create_avl_tree: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
