/**
 * Layer C3.a — Byte-level mutation testing for the Xor arm.
 *
 * Xor has TWO inline `Const(Coll[Byte], ...)` operands (LEFT and RIGHT).
 * `findInlineByteColls` returns both, in depth-first wire order:
 *   - collIndex 0 = LEFT operand
 *   - collIndex 1 = RIGHT operand
 *
 * Strategy: mutate the LEFT operand only (collIndex=0). LEFT mutations always
 * propagate to the output for indices < min(left, right) — since XOR is
 * bijective per byte, the output differs in exactly those positions where
 * LEFT changed (within the truncated overlap region). For the asymmetric
 * `xor_left_long_right_short` (LEFT=200, RIGHT=10), only the FIRST 10 bytes
 * of LEFT affect the output — mutations in offsets >= 10 of LEFT are silent
 * (output unchanged). Those mutations would survive against the
 * `isKillStandard` rule, so we exclude the silent tail via `excludedOffsets`
 * for that one fixture. (The cost is still charged by LEFT's full length, but
 * the cost is a fixed scalar tied only to ceil(n/128) chunks, not to byte
 * content — so mutating tail bytes never changes the cost either.)
 *
 * Skipped fixtures:
 *   - `xor_empty`: no bytes to mutate.
 *   - `xor_identical_zero`: LEFT and RIGHT are both `[0x42; 16]`, so the byte
 *     pattern appears TWICE in `treeBytes` → `locateBytes` raises ambiguous.
 *   - `xor_1byte`: LEFT is `[0x01]`, a common byte value appearing elsewhere
 *     in the ErgoTree envelope (header / opcode), so `locateBytes` raises
 *     ambiguous. The other 1-byte fixture `xor_both_single` (LEFT `[0x42]`)
 *     is unambiguous and provides 1-byte coverage.
 *
 * For each surviving fixture: XOR patterns {0xFF, 0x01, 0x80} × LEFT-region
 * bytes. Per `isKillStandard`: both threw → not a kill; one threw → kill;
 * both ok → kill iff values differ.
 *
 * Threshold: ≥ 0.90 per arm (aggregate across surviving entries).
 *
 * Source: ergotree-interpreter/src/eval/xor.rs:13-41
 * Pattern: calc-blake2b256-mutation.test.ts (shared harness in
 *          test/_helpers/mutation-harness.ts).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { hexToBytes } from '../_helpers'
import {
  findInlineByteColls,
  locateBytes,
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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'xor.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

// Fixtures we cannot mutate cleanly (see file doc comment for reasons).
const SKIPPED = new Set<string>([
  'xor_empty',
  'xor_identical_zero',
  'xor_1byte',
])

describe('Xor mutation testing (Layer C3.a)', () => {
  const entries = fixture.entries.filter((e) => !SKIPPED.has(e.name))
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on LEFT-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)
      const colls = findInlineByteColls(tree.body)
      // We expect exactly 2 inline Coll[Byte] per Xor: LEFT and RIGHT.
      expect(colls.length).toBe(2)
      const leftBytes = colls[0]!
      const rightBytes = colls[1]!
      const leftStart = locateBytes(treeBytes, leftBytes)
      const leftEnd = leftStart + leftBytes.length

      // For LEFT longer than RIGHT, mutations in LEFT[rightLen..) are silent
      // (XOR output is truncated to min length). Exclude those offsets so
      // they don't count against the kill rate.
      const excluded = new Set<number>()
      if (leftBytes.length > rightBytes.length) {
        for (let i = leftStart + rightBytes.length; i < leftEnd; i++) {
          excluded.add(i)
        }
      }

      const result = runMutationLoop({
        treeBytes,
        region: { start: leftStart, end: leftEnd },
        optsJson: entry.opts_json,
        excludedOffsets: excluded,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] xor.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `leftLen=${leftBytes.length} rightLen=${rightBytes.length} ` +
          `leftStart=${leftStart} excluded=${excluded.size}`,
      )
      aggKilled += result.killed
      aggTotal += result.total
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`Xor: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG xor: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
