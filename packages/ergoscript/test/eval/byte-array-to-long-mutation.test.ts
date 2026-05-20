/**
 * Layer C3.a — Byte-level mutation testing for the ByteArrayToLong arm.
 *
 * For each success-path fixture (skipping error entries `b2l_empty` and
 * `b2l_length_7`):
 *   1. Parse the ErgoTree from `tree_bytes_hex`.
 *   2. Locate the input Coll[Byte] payload bytes within `tree_bytes_hex` via
 *      `locateInlineCollRegion(treeBytes, tree, 0)` (the only inline
 *      Coll[Byte] is the immediate `Const(Coll[Byte], …)` child of the outer
 *      ByteArrayToLong node).
 *   3. Restrict mutation to the FIRST 8 BYTES of the region — ByteArrayToLong
 *      reads bytes [0..7] BE and IGNORES the tail (sigma-rust's
 *      `eval_skip_tail` test at byte_array_to_long.rs:62-65). Mutating
 *      consensus-invisible trailing bytes is a known survivor by design;
 *      we explicitly carve them out so the kill rate measures the
 *      consensus-affecting bytes only.
 *   4. For each byte in the restricted region, apply 3 XOR patterns
 *      (0xFF, 0x01, 0x80).
 *   5. A mutation counts as KILLED if the mutated value differs from the
 *      unmutated baseline (or throws where baseline didn't / didn't throw
 *      where baseline did). Per the `isKillStandard` rule.
 *   6. Threshold ≥ 0.90 per arm (aggregate across all entries).
 *
 * Source: ergotree-interpreter/src/eval/byte_array_to_long.rs:18-34
 * Pattern: calc-blake2b256-mutation.test.ts (Phase 2i-a T2).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { hexToBytes } from '../_helpers'
import {
  locateInlineCollRegion,
  runMutationLoop,
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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'byte-array-to-long.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

describe('ByteArrayToLong mutation testing (Layer C3.a)', () => {
  // Skip the error entries (no successful baseline to compare against).
  // All remaining entries have exactly one inline Coll[Byte] in the body —
  // `collIndex: 0`.
  const entries = fixture.entries.filter(
    (e) => e.name !== 'b2l_empty' && e.name !== 'b2l_length_7',
  )
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on input-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)
      const region = locateInlineCollRegion(treeBytes, tree, 0)
      // Restrict to the first 8 bytes (the consensus-affecting prefix).
      // Trailing bytes (skip-tail entries) are intentionally ignored by
      // ByteArrayToLong — mutating them is a known survivor by design.
      const mutationEnd = Math.min(region.start + 8, region.end)
      const result = runMutationLoop({
        treeBytes,
        region: { start: region.start, end: mutationEnd },
        optsJson: entry.opts_json,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] byte_array_to_long.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `inputLen=${region.length} mutatedLen=${mutationEnd - region.start} ` +
          `inputStart=${region.start}`,
      )
      aggKilled += result.killed
      aggTotal += result.total
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`ByteArrayToLong: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG byte_array_to_long: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
