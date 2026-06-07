/**
 * Layer C3.a — Byte-level mutation testing for the 6 Tier-2 SAvlTree
 * verification op handlers.
 *
 * For each success-path fixture across the 6 verification handlers:
 *   1. Parse the ErgoTree from `tree_bytes_hex`.
 *   2. Locate the proof's inline `Const(Coll[Byte], …)` payload bytes within
 *      `tree_bytes_hex`. The proof is the SECOND inline Coll[Byte] for the
 *      single-key handlers (`contains`, `get`), and the FIRST (and only)
 *      inline Coll[Byte] for the multi-arg handlers (`getMany`, `insert`,
 *      `update`, `remove`). Substring search returns a unique offset for
 *      every shipped fixture — verified at test-write time.
 *   3. For each byte in the proof region, apply 3 XOR mutation patterns
 *      (0xFF, 0x01, 0x80). Each mutated wire byte string is re-parsed and
 *      re-evaluated.
 *   4. A mutation counts as KILLED if the result differs from the
 *      unmutated baseline (different SValue, OR throws where baseline
 *      didn't, OR no-throw where baseline threw).
 *   5. SURVIVED = same baseline outcome under mutation (proof region byte
 *      flip tolerated). Per-handler threshold ≥ 0.90.
 *
 * Per-handler kill criteria (JVM-canonical, F4):
 *   - `contains` — result flip only (true↔false); NEVER throws (F4: construct and
 *      per-op failures both → false; "kill if throw" is impossible for contains).
 *   - `get` / `getMany` — kill if throw OR Option content differs.
 *   - `remove` — kill if Option content differs (NEVER throws post-F4; throw
 *      would also kill, but is unreachable).
 *   - `insert` / `update` — kill if throw OR returned successor digest differs
 *      (update never throws post-F4; insert throws only at V<3 with ≥1 op).
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:104-439.
 * Established pattern: `eval-mutation.test.ts` (Phase 2f Coll HOFs Layer C3.a)
 * — same aggregate-score discipline (per-arm threshold), but byte-level
 * mutations on the wire bytes instead of Expr-tree operators. The byte-level
 * approach is appropriate here because the proof is opaque to the MIR layer
 * (it's just a `Const(Coll[Byte], …)` payload).
 *
 * Phase 2h-b Phase G; harness extracted to test/_helpers/mutation-harness.ts
 * in Phase 2h-e (2026-05-20).
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
const fixturesDir = join(__dirname, '..', 'fixtures', 'eval')

function loadFixture(file: string): FixtureFile {
  return JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8')) as FixtureFile
}

const HANDLERS: Array<{
  name: string
  file: string
  collIndex: 0 | 1 // 0 = first inline Coll[Byte], 1 = second
  successEntries: string[]
}> = [
  {
    name: 'contains',
    file: 'savltree-contains.json',
    collIndex: 1,
    // JVM (F4): contains NEVER throws; all failure paths → false.
    // `contains_key_absent` baseline is already false; a mutated proof also
    // returns false (bad proof collapses to "absent") → 0% kill rate is
    // expected and not a test gap. Only true-baseline entries can detect kills.
    successEntries: ['contains_key_present', 'contains_bytes_key_32'],
  },
  {
    name: 'get',
    file: 'savltree-get.json',
    collIndex: 1,
    successEntries: ['get_key_present', 'get_key_absent', 'get_bytes_key_32'],
  },
  {
    name: 'getMany',
    file: 'savltree-get-many.json',
    collIndex: 0,
    successEntries: ['get_many_all_present', 'get_many_mixed_2_of_3', 'get_many_all_absent'],
  },
  {
    name: 'insert',
    file: 'savltree-insert.json',
    collIndex: 0,
    successEntries: ['insert_success_1_entry', 'insert_success_3_entries'],
  },
  {
    name: 'update',
    file: 'savltree-update.json',
    collIndex: 0,
    successEntries: ['update_success_1_entry', 'update_success_3_entries'],
  },
  {
    name: 'remove',
    file: 'savltree-remove.json',
    collIndex: 0,
    successEntries: ['remove_success_1_key', 'remove_success_3_keys'],
  },
]

describe('SAvlTree mutation testing (Layer C3.a)', () => {
  for (const handler of HANDLERS) {
    describe(`SAvlTree.${handler.name}`, () => {
      const fixture = loadFixture(handler.file)
      const entries = fixture.entries.filter((e) => handler.successEntries.includes(e.name))
      let aggKilled = 0
      let aggTotal = 0

      for (const entry of entries) {
        it(`${entry.name}: ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on proof-byte mutations`, () => {
          const treeBytes = hexToBytes(entry.tree_bytes_hex)
          const tree = parseTree(treeBytes)
          const region = locateInlineCollRegion(treeBytes, tree, handler.collIndex)
          const result = runMutationLoop({
            treeBytes,
            region: { start: region.start, end: region.end },
            optsJson: entry.opts_json,
          })
          // eslint-disable-next-line no-console
          console.log(
            `[mutation] ${handler.name}.${entry.name}: killed=${result.killed} ` +
              `total=${result.total} rate=${result.rate.toFixed(3)} ` +
              `proofLen=${region.length} proofStart=${region.start}`,
          )
          aggKilled += result.killed
          aggTotal += result.total
          expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
        })
      }

      it(`SAvlTree.${handler.name}: aggregate kill rate ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
        const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
        // eslint-disable-next-line no-console
        console.log(
          `[mutation] AGG ${handler.name}: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
        )
        expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
      })
    })
  }
})
