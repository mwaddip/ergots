/**
 * Layer C3.a — Byte-level mutation testing for the CalcSha256 arm.
 *
 * For each success-path fixture (skipping `calc_sha256_empty` since there
 * are no bytes to mutate):
 *   1. Parse the ErgoTree from `tree_bytes_hex`.
 *   2. Locate the input Coll[Byte] payload bytes within `tree_bytes_hex` via
 *      `locateInlineCollRegion(treeBytes, tree, 0)` (the only inline
 *      Coll[Byte] is the immediate `Const(Coll[Byte], …)` child of the outer
 *      CalcSha256 node — except for `calc_sha256_chain`, which has
 *      a nested CalcSha256 around the only inline Coll[Byte]).
 *   3. For each byte in the region, apply 3 XOR patterns (0xFF, 0x01, 0x80).
 *   4. A mutation counts as KILLED if the mutated digest differs from the
 *      unmutated baseline digest (or throws where baseline didn't / didn't
 *      throw where baseline did). Per the `isKillStandard` rule.
 *   5. Threshold ≥ 0.90 per arm (aggregate across all entries).
 *
 * sha256 is preimage-resistant + diffusive, so even a single-bit flip in
 * the input changes ~half the output bits. Expected kill rate ≈ 1.0.
 *
 * Source: ergotree-interpreter/src/eval/calc_sha256.rs:14-34
 * Pattern: savltree-mutation.test.ts (Phase 2h-b Phase G, harness in
 *          test/_helpers/mutation-harness.ts).
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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'calc-sha256.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

describe('CalcSha256 mutation testing (Layer C3.a)', () => {
  // Skip the empty fixture (no bytes to mutate). All remaining entries have
  // exactly one inline Coll[Byte] in the body — `collIndex: 0`.
  const entries = fixture.entries.filter((e) => e.name !== 'calc_sha256_empty')
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on input-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)
      const region = locateInlineCollRegion(treeBytes, tree, 0)
      const result = runMutationLoop({
        treeBytes,
        region: { start: region.start, end: region.end },
        optsJson: entry.opts_json,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] calc_sha256.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `inputLen=${region.length} inputStart=${region.start}`,
      )
      aggKilled += result.killed
      aggTotal += result.total
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`CalcSha256: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG calc_sha256: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
