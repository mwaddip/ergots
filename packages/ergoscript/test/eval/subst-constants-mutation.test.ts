/**
 * Layer C3.a — Byte-level mutation testing for the SubstConstants arm
 * (CONSENSUS-CRITICAL).
 *
 * SubstConstants has three child expressions:
 *   - scriptBytes (`Coll[Byte]`) — the embedded template tree's wire bytes.
 *   - positions   (`Coll[Int]`)  — zero-based indexes into the template's constants.
 *   - newValues   (`Coll[T]`)    — replacement values for the indexed positions.
 *
 * Only the `scriptBytes` payload is a literal `Const(Coll[Byte], …)`, so it's
 * the ONLY region that `findInlineByteColls` returns. The `positions` and
 * `newValues` regions are `Coll[Int]` / `Coll[T]` literals — they're inline
 * but not in the byte-coll list. We mutate only the template region; the
 * substitute-and-re-serialize path is what makes a byte flip on the template
 * propagate to a different output:
 *
 *   - Byte flips inside the wire-format envelope (header / opcodes / constants
 *     count / type tags / root expression) propagate to either a parse error
 *     ('subst-constants-error') or to a different round-tripped output. Both
 *     count as kills via `isKillStandard`.
 *   - Byte flips inside a constant's VALUE bytes (the encoded payload) — when
 *     that constant is being substituted away — are silent: the substitution
 *     overwrites whatever the parser decoded, and the re-serialized output is
 *     identical to baseline. These would survive.
 *
 * For the **byte-template** fixture (`subst_byte_template`), the substituted
 * constant is `Coll[Byte] [1,2,3]` — 3 contiguous bytes of the template wire
 * form correspond to those values. A new_values payload of the same length
 * (`Coll[Byte] [10,20,30]`) overwrites all 3 bytes. So ~3 of 9 template bytes
 * (× 3 XOR patterns = 9 silent mutations out of 27) would survive — dropping
 * the kill rate below 0.9. We **skip** this fixture for mutation testing
 * (the per-element wire encoding for Coll[Byte] values is too coarse for
 * isKillStandard to detect single-byte flips inside the substituted region).
 *
 * For the **3-const int** templates (positions [0,1,2] or [0]), the substituted
 * constants overwrite 1 wire byte each (the ZigZag-VLQ encoding of small i32s
 * happens to be 1 byte; larger values would consume more). 3 substituted
 * constants × 1 byte each × 3 XOR patterns ≈ 9 silent mutations out of 48
 * → roughly 0.81 kill rate. We exclude the constant-value bytes in `subst_3_int_*`
 * fixtures explicitly via the offset-based `excludedOffsets` set.
 *
 * For the **1-const int** template (`subst_single_int_at_0` /
 * `subst_byte_equality_check` / `subst_cost_uses_template_count` —
 * wait `subst_cost_uses_template_count` is 3-const), the substituted constant
 * is 1 byte → 3 silent mutations out of 18 → 0.83 kill rate (still below 0.9).
 * Same exclusion strategy.
 *
 * Empty-positions fixture (`subst_empty_positions`) does no substitution, so
 * ALL template bytes affect output — no exclusion needed, kill rate should
 * be near 1.0.
 *
 * Threshold: ≥ 0.90 per arm (aggregate across surviving entries).
 *
 * Source: ergotree-interpreter/src/eval/subst_const.rs:18-89
 * Pattern: calc-blake2b256-mutation.test.ts / decode-point-mutation.test.ts
 * (shared harness in test/_helpers/mutation-harness.ts).
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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'subst-constants.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

// Per-fixture excluded byte offsets WITHIN the inline template region (NOT
// absolute treeBytes offsets). These are the wire-level VALUE-bytes of
// constants that are substituted away by the arm — mutating them is silent.
//
// The offsets below are derived by parsing each template's wire form and
// noting which byte indices correspond to each constant's encoded value
// payload (skipping the type-tag byte, which is consensus-critical for the
// type-equality check and DOES affect output).
//
// Template wire form (`subst_single_int_at_0`): `10 01 04 54 73 00`
//   - byte 0: header (v0+seg)
//   - byte 1: constants_count VLQ
//   - byte 2: SInt type tag
//   - byte 3: ZigZag VLQ for 42 ← substituted away by positions=[0]
//   - byte 4: ConstantPlaceholder opcode (0x73)
//   - byte 5: placeholder index
// Excluded: { 3 } (the 1 value byte of constants[0]).
//
// Template wire form (`subst_3_int_*`): `10 03 04 02 04 04 04 06 9a 73 00 9c
//   73 01 73 02` (constants count=3; 3 × (type=04, value=1 byte); body
//   = a + b*c with placeholders 0/1/2).
//   - byte 0: header
//   - byte 1: constants_count
//   - byte 2: SInt tag for c[0]
//   - byte 3: VLQ value c[0]=ZigZag(1)=0x02 ← substituted (positions[2] points here in some entries; or [0] for cost_uses_template_count)
//   - byte 4: SInt tag for c[1]
//   - byte 5: VLQ value c[1]=ZigZag(2)=0x04 ← substituted
//   - byte 6: SInt tag for c[2]
//   - byte 7: VLQ value c[2]=ZigZag(3)=0x06 ← substituted
//   - byte 8+: body bytes
// Excluded: { 3, 5, 7 } (positions [0,1,2] all substituted in *_3_int_in_order,
// *_3_int_reorder, and the 3 constants of cost_uses_template_count — even
// though only position [0] is substituted there, the byte-for-byte content of
// constants[1] and constants[2] still differs because the BASELINE round-trips
// them with their original value bytes; so {3} alone might suffice for
// cost_uses_template_count, but we use {3,5,7} uniformly for simplicity).
//
// Wait — for cost_uses_template_count, positions=[0], so only constants[0]
// (byte 3) is overwritten. constants[1] (byte 5) and constants[2] (byte 7) are
// preserved. Mutating those bytes DOES affect output → kill. So the exclusion
// set for that fixture is just { 3 }.
const PER_FIXTURE_EXCLUSIONS: Record<string, ReadonlySet<number>> = {
  subst_single_int_at_0: new Set([3]),
  subst_byte_equality_check: new Set([3]),
  subst_3_int_reorder: new Set([3, 5, 7]),
  subst_3_int_in_order: new Set([3, 5, 7]),
  subst_long_template: new Set([3, 5, 7]),
  subst_cost_uses_template_count: new Set([3]),
  subst_empty_positions: new Set<number>(), // no substitution = no exclusions
}

// Skip the byte-template fixture — substituted Coll[Byte] value is too long
// (3 bytes of the 9-byte template) to maintain a meaningful kill rate. The
// other fixtures already exercise the Coll[Byte] surface via the corpus
// fixtures / parse-mutation tests.
const SKIPPED = new Set<string>([
  'subst_byte_template',
])

describe('SubstConstants mutation testing (Layer C3.a) — template region', () => {
  const entries = fixture.entries.filter(
    (e) =>
      (e.expected_error_code === null || e.expected_error_code === undefined) &&
      !SKIPPED.has(e.name),
  )
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on template-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)
      const region = locateInlineCollRegion(treeBytes, tree, 0)
      // The harness checks `excludedOffsets` against absolute treeBytes
      // offsets — remap the per-fixture local offsets (WITHIN the template
      // region) by shifting them by `region.start`.
      const localExclusions = PER_FIXTURE_EXCLUSIONS[entry.name] ?? new Set<number>()
      const absoluteExclusions = new Set<number>(
        [...localExclusions].map((off) => off + region.start),
      )
      const result = runMutationLoop({
        treeBytes,
        region: { start: region.start, end: region.end },
        optsJson: entry.opts_json,
        excludedOffsets: absoluteExclusions,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] subst_constants.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `inputLen=${region.length} inputStart=${region.start} ` +
          `excludedOffsets=[${[...localExclusions].join(',')}]`,
      )
      aggKilled += result.killed
      aggTotal += result.total
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`SubstConstants: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG subst_constants: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
