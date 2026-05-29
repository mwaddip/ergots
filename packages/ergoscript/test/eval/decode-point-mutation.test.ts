/**
 * Layer C3.a — Byte-level mutation testing for the DecodePoint arm.
 *
 * For each success-path fixture, mutate the inline 33-byte Coll[Byte] payload
 * (the immediate `Const(Coll[Byte], …)` child of the outer DecodePoint node).
 * Per `isKillStandard`:
 *   - baseline ok + mutated throws  → kill (parse rejected an off-curve / bad-encoding flip)
 *   - baseline ok + mutated ok      → kill iff values differ (mutated point ≠ baseline)
 *   - both throw                    → not a kill (excluded — no success-path baseline)
 *
 * Expected behaviour by entry:
 *   - `dp_generator`  : flipping any byte produces either an off-curve point
 *                       (most flips → throw, kill) or a valid different point
 *                       (rare: y-coordinate parity flip on 0x02 ↔ 0x03 tag,
 *                        which yields the y-negation of the generator → value
 *                        differs → kill).
 *                       Expected kill rate ≈ 1.0.
 *   - `dp_identity`   : all 33 bytes are zero. XOR-with-0xFF/0x01 patterns:
 *                       * pattern 0xFF on byte 0 → tag becomes 0xFF (off-curve → throw, kill).
 *                       * pattern 0x01 on byte 0 → tag becomes 0x01 (sigma-rust would
 *                         dispatch as identity since buf[0]!=0 is FALSE here; our
 *                         adapter sees `[0x01, 0x00, ...]` which fails the
 *                         isZero33 short-circuit and falls through to fromBytes
 *                         → tag 0x01 is INVALID for compressed SEC1 → throws → kill).
 *                       * pattern 0xFF on any byte i≥1 → adapter sees 32 zero bytes
 *                         + one 0xFF — fails isZero33 → falls through to fromBytes
 *                         → invalid compressed SEC1 (tag byte 0x00 is reserved
 *                         for identity in raw SEC1) → throws → kill.
 *                       * pattern 0x01 on any byte i≥1 → same as above → kill.
 *                       * pattern 0x80 on any byte → bit-7 flip → still fails
 *                         identity check and yields invalid encoding → kill.
 *                       Expected kill rate ≈ 1.0.
 *
 *   ⚠ Note on potential survivors: any mutation that produces another valid
 *   33-byte SEC1 point whose first-byte parity flip yields the same scalar
 *   point would survive `isKillStandard`. For the generator point that's only
 *   the 0x02 ↔ 0x03 single-bit flip (kills, since the resulting point's
 *   y-coordinate is negated → different bytes after re-encoding).
 *
 * Threshold: ≥ 0.90 per arm (aggregate across all entries).
 *
 * Skipped fixtures:
 *   - error entries (no success-path baseline; `runMutationLoop` filters via
 *     baseline-ok kill rule — but we skip them explicitly to keep the report
 *     focused on the mutation surface that actually exercises the parser).
 *
 * Source: ergotree-interpreter/src/eval/decode_point.rs:14-30
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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'decode-point.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

/**
 * iter-24: sigma-rust treats ANY 0x00-lead input as the identity and never
 * inspects bytes 1..32 (`ec_point.rs:139-151`), so mutating those bytes is a
 * consensus no-op — NOT a detectable kill. Kill-rate mutation testing is only
 * meaningful for NON-identity points (e.g. `dp_generator`); identity-valued
 * success entries are excluded from the loop.
 */
function isIdentityGroupElement(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { kind?: unknown }).kind === 'GroupElement' &&
    typeof (v as { bytes_hex?: unknown }).bytes_hex === 'string' &&
    /^0{66}$/.test((v as { bytes_hex: string }).bytes_hex)
  )
}

describe('DecodePoint mutation testing (Layer C3.a)', () => {
  // Skip error entries (no success-path baseline). All remaining entries have
  // exactly one inline Coll[Byte] in the body — `collIndex: 0`. Also skip
  // identity (0x00-lead) inputs — see isIdentityGroupElement (iter-24).
  const entries = fixture.entries.filter(
    (e) =>
      (e.expected_error_code === null || e.expected_error_code === undefined) &&
      !isIdentityGroupElement(e.expected_value_json),
  )
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
        `[mutation] decode_point.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `inputLen=${region.length} inputStart=${region.start}`,
      )
      aggKilled += result.killed
      aggTotal += result.total
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`DecodePoint: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG decode_point: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
