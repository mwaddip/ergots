/**
 * Layer C3.a — Byte-level mutation testing for the ByteArrayToBigInt arm.
 *
 * UNLIKE ByteArrayToLong (T4) which uses `locateInlineCollRegion`, this arm
 * has fixtures with very short payloads (e.g. `b2bi_plus_one` is a single
 * byte 0x01) that collide with VLQ-length bytes elsewhere in the tree —
 * `locateBytes` rejects them as ambiguous. Mirroring LongToByteArray (T5),
 * we hard-code the payload offset from the known fixed prefix instead.
 *
 * Tree layout for each fixture is:
 *   [0] = 0x00         ErgoTreeHeader v0, no constant segregation
 *   [1] = 0x7b         OP_BYTE_ARRAY_TO_BIGINT (123)
 *   [2] = 0x0e         OP_CONST_COLL_BYTE (typed Coll[Byte] constant)
 *   [3] = VLQ length   (single byte for all our fixtures: 0..33 fits in 7 bits)
 *   [4..] = payload bytes (Coll[Byte] data)
 *
 * We mutate every byte in `[4..treeBytes.length)` — the entire input payload.
 * UNLIKE ByteArrayToLong, ByteArrayToBigInt reads ALL input bytes
 * (`BigInt256::from_be_slice(&input[..])` at byte_array_to_bigint.rs:25), so
 * no skip-tail carve-out is needed.
 *
 * Header, opcode, inner-opcode, and VLQ length bytes (`[0..4)`) are
 * intentionally NOT mutated — they're wire-format concerns, not
 * consensus-output concerns for this arm.
 *
 * Threshold ≥ 0.90 per arm (aggregate across all entries).
 *
 * Source: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34
 * Pattern: long-to-byte-array-mutation.test.ts (Phase 2i-a T5).
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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'byte-array-to-bigint.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

// Payload offset within tree bytes:
//   [0] header, [1] OP_BYTE_ARRAY_TO_BIGINT, [2] OP_CONST_COLL_BYTE, [3] VLQ length.
const PAYLOAD_START = 4

describe('ByteArrayToBigInt mutation testing (Layer C3.a)', () => {
  // Skip the error entries (no successful baseline to compare against).
  const entries = fixture.entries.filter(
    (e) => e.name !== 'b2bi_empty' && e.name !== 'b2bi_33byte_above_max',
  )
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on input-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      // Sanity-check the fixed prefix (defends against fixture drift).
      expect(treeBytes[0]).toBe(0x00)
      expect(treeBytes[1]).toBe(0x7b)
      expect(treeBytes[2]).toBe(0x0e)
      // VLQ length byte: high bit must be 0 for our 0..33-byte fixtures.
      expect(treeBytes[3]! & 0x80).toBe(0)
      const result = runMutationLoop({
        treeBytes,
        region: { start: PAYLOAD_START, end: treeBytes.length },
        optsJson: entry.opts_json,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] byte_array_to_bigint.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} ` +
          `payloadLen=${treeBytes.length - PAYLOAD_START} payloadStart=${PAYLOAD_START}`,
      )
      aggKilled += result.killed
      aggTotal += result.total
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`ByteArrayToBigInt: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG byte_array_to_bigint: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
