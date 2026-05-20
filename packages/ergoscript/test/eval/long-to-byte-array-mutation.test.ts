/**
 * Layer C3.a — Byte-level mutation testing for the LongToByteArray arm.
 *
 * UNLIKE the other 2i-a predef arms (CalcBlake2b256, CalcSha256, ByteArrayToLong),
 * the LongToByteArray input is an i64 Const encoded as a **ZigZag VLQ** in the
 * tree body, NOT an inline `Coll[Byte]`. The shared mutation harness's
 * `findInlineByteColls` cannot locate this region, so we drive `runMutationLoop`
 * with a hand-computed region instead.
 *
 * Tree layout for each fixture is:
 *   [0] = 0x00         ErgoTreeHeader v0, no constant segregation
 *   [1] = 0x7a         OP_LONG_TO_BYTE_ARRAY (122)
 *   [2] = 0x05         OP_CONST_LONG (typed Long constant)
 *   [3..] = ZigZag VLQ-encoded i64 payload (1..10 bytes)
 *
 * We mutate every byte in `[3..treeBytes.length)` — the entire encoded Long
 * payload. Mutations on any payload byte either:
 *   - Change the decoded i64 → different 8-byte BE output → kill.
 *   - Flip a VLQ continuation bit, producing a different / shorter value → kill.
 *   - Break the VLQ parse entirely → parse-error → kill (treated as throw).
 *
 * Header and opcode bytes (`[0..2]`) are intentionally NOT mutated:
 *   - Byte 0: tree-header mutations bypass LongToByteArray entirely (a different
 *     header version / constant-segregation mode is a wire-format concern, not
 *     a consensus-output concern).
 *   - Byte 1: opcode mutations turn this into a different arm — also not in
 *     scope for LongToByteArray's consensus surface.
 *   - Byte 2: the inner constant-opcode is the type tag for SLong (0x05);
 *     mutating it switches the constant to a different type. The handler's
 *     type guard (`'predef-input-not-long'`) catches this, so the kill rate
 *     would be 100%, but the test would not exercise LongToByteArray's actual
 *     i64-encoding logic. Out of scope.
 *
 * Threshold ≥ 0.90 per arm (aggregate across all entries).
 *
 * Source: ergotree-interpreter/src/eval/long_to_byte_array.rs:11-25
 * Pattern: byte-array-to-long-mutation.test.ts (Phase 2i-a T4).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hexToBytes } from '../_helpers'
import { runMutationLoop, DEFAULT_KILL_THRESHOLD } from '../_helpers/mutation-harness'

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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'long-to-byte-array.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

// Byte offset where the ZigZag VLQ payload begins inside the tree body:
//   [0] header, [1] OP_LONG_TO_BYTE_ARRAY, [2] OP_CONST_LONG type tag.
const PAYLOAD_START = 3

describe('LongToByteArray mutation testing (Layer C3.a)', () => {
  // All fixture entries are success paths (no error fixtures — non-SLong
  // inputs are rejected at build-time by sigma-rust, see fixture-gen module).
  const entries = fixture.entries
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on encoded-Long-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      // Sanity-check the fixed prefix (defends against fixture drift).
      expect(treeBytes[0]).toBe(0x00)
      expect(treeBytes[1]).toBe(0x7a)
      expect(treeBytes[2]).toBe(0x05)
      const result = runMutationLoop({
        treeBytes,
        region: { start: PAYLOAD_START, end: treeBytes.length },
        optsJson: entry.opts_json,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] long_to_byte_array.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `payloadLen=${treeBytes.length - PAYLOAD_START} payloadStart=${PAYLOAD_START}`,
      )
      aggKilled += result.killed
      aggTotal += result.total
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`LongToByteArray: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG long_to_byte_array: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
