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
 * Per-handler kill criteria (from Phase F source-read of savltree.rs):
 *   - `contains` — kill if throw OR result becomes `false` (vs baseline `true`)
 *      OR result becomes `true` (vs baseline `false`).
 *   - `get` / `getMany` / `remove` — kill if throw OR Option content differs.
 *   - `insert` / `update` — kill if throw OR returned successor digest differs.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:104-439.
 * Established pattern: `eval-mutation.test.ts` (Phase 2f Coll HOFs Layer C3.a)
 * — same aggregate-score discipline (per-arm threshold), but byte-level
 * mutations on the wire bytes instead of Expr-tree operators. The byte-level
 * approach is appropriate here because the proof is opaque to the MIR layer
 * (it's just a `Const(Coll[Byte], …)` payload).
 *
 * Phase 2h-b Phase G.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import type { ErgoTree, Expr, SValue } from '../../src/mir/types'
import { hexToBytes, rehydrateEvalOpts } from '../_helpers'

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

// ---------------------------------------------------------------------------
// Proof-region locator
// ---------------------------------------------------------------------------

/**
 * Collect every inline `Const(Coll[Byte], …)` value reachable from `expr`,
 * in depth-first order.
 *
 * Used to identify the proof bytes embedded in the body. The single-key
 * handlers (`contains` / `get`) have the proof as the SECOND such Const
 * (first is the key); the multi-arg handlers have a single Coll[Byte]
 * which is the proof (keys/entries arrive via a different wire encoding
 * — `Coll[Coll[Byte]]` or `Coll[(Coll[Byte], Coll[Byte])]`, not flat).
 */
function findInlineByteColls(expr: Expr): Uint8Array[] {
  const out: Uint8Array[] = []
  walk(expr)
  return out

  function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (
      n['tag'] === 'Const' &&
      typeof n['tpe'] === 'object' &&
      n['tpe'] !== null &&
      (n['tpe'] as Record<string, unknown>)['tag'] === 'SColl' &&
      typeof (n['tpe'] as Record<string, unknown>)['elem'] === 'object' &&
      ((n['tpe'] as Record<string, unknown>)['elem'] as Record<string, unknown>)['tag'] ===
        'SByte' &&
      typeof n['value'] === 'object' &&
      n['value'] !== null &&
      (n['value'] as Record<string, unknown>)['kind'] === 'Coll'
    ) {
      const items = (n['value'] as Record<string, unknown>)['items'] as Array<{ value: number }>
      const bytes = new Uint8Array(items.length)
      for (let i = 0; i < items.length; i++) {
        bytes[i] = items[i]!.value & 0xff
      }
      out.push(bytes)
    }
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) {
        for (const item of v) walk(item)
      } else if (v !== null && typeof v === 'object') {
        walk(v)
      }
    }
  }
}

/** Locate `needle` as a contiguous byte substring of `haystack`; return the
 * starting BYTE offset. Throws if zero or multiple matches (ambiguous).
 */
function locateBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) throw new Error('locateBytes: empty needle')
  const matches: number[] = []
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    matches.push(i)
    if (matches.length > 1) break
  }
  if (matches.length === 0) {
    throw new Error('locateBytes: needle not found in haystack')
  }
  if (matches.length > 1) {
    throw new Error(`locateBytes: ambiguous (>=2 matches in haystack)`)
  }
  return matches[0]!
}

/**
 * Locate the proof region (start, end) byte offsets within `tree_bytes_hex`
 * (decoded to bytes). `whichColl` selects which inline `Coll[Byte]` is the
 * proof — 'first' for getMany/insert/update/remove, 'second' for contains/get.
 */
function locateProofRegion(
  treeBytes: Uint8Array,
  tree: ErgoTree,
  whichColl: 'first' | 'second'
): { start: number; end: number; proofLen: number } {
  const byteColls = findInlineByteColls(tree.body)
  const wantIdx = whichColl === 'first' ? 0 : 1
  if (byteColls.length <= wantIdx) {
    throw new Error(
      `locateProofRegion: expected ≥${wantIdx + 1} inline Coll[Byte], got ${byteColls.length}`
    )
  }
  const proofBytes = byteColls[wantIdx]!
  const start = locateBytes(treeBytes, proofBytes)
  return { start, end: start + proofBytes.length, proofLen: proofBytes.length }
}

// ---------------------------------------------------------------------------
// Evaluation harness
// ---------------------------------------------------------------------------

type EvalOutcome =
  | { ok: true; value: SValue }
  | { ok: false; errorCode: string | undefined; errorMessage: string }

function evalSafely(treeBytes: Uint8Array, optsJson: Record<string, unknown>): EvalOutcome {
  try {
    const tree = parseTree(treeBytes)
    const ctx = makeContext(rehydrateEvalOpts(optsJson))
    const value = evaluateWith(tree, ctx)
    return { ok: true, value }
  } catch (e) {
    if (e instanceof EvalError) {
      return { ok: false, errorCode: e.code, errorMessage: e.message }
    }
    if (e instanceof Error) {
      return { ok: false, errorCode: undefined, errorMessage: e.message }
    }
    return { ok: false, errorCode: undefined, errorMessage: String(e) }
  }
}

/** Deep-equal two SValues via JSON serialization (BigInt-safe). */
function svalueEqual(a: SValue, b: SValue): boolean {
  const replacer = (_k: string, v: unknown): unknown =>
    typeof v === 'bigint' ? `__bigint__${v.toString()}__` : v
  return JSON.stringify(a, replacer) === JSON.stringify(b, replacer)
}

/**
 * A "kill" = the mutated outcome is observably different from the baseline.
 *
 * Cases:
 *   - both threw: NOT a kill (mutation didn't change behavior — though
 *     pre-call mutation in `parseTree` shouldn't happen on success
 *     baselines; defensive).
 *   - baseline threw, mutated didn't: kill (unexpected reversal).
 *   - baseline didn't throw, mutated did: kill (most common case).
 *   - both succeeded: kill iff values differ.
 *
 * The handler name is unused — all six handlers follow the same
 * "throw OR diverge" kill rule. Kept as a parameter for documentation /
 * future per-handler refinement.
 */
function isKill(baseline: EvalOutcome, mutated: EvalOutcome, _handler: string): boolean {
  if (!baseline.ok && !mutated.ok) return false
  if (!baseline.ok && mutated.ok) return true
  if (baseline.ok && !mutated.ok) return true
  // Both ok — compare values.
  if (!baseline.ok || !mutated.ok) return false // narrowing
  return !svalueEqual(baseline.value, mutated.value)
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

/**
 * Per-handler config:
 *   - file: fixture filename
 *   - whichColl: which inline Coll[Byte] is the proof
 *   - successEntries: scenario names that exercise the verifier on success
 *     (i.e., would observe a kill if the proof bytes were mutated). Excludes
 *     `*_disallowed_flags` (short-circuit before proof use) and
 *     `contains_proof_mutated` (already a per-op-fail case; not a baseline).
 */
const HANDLERS: Array<{
  name: string
  file: string
  whichColl: 'first' | 'second'
  successEntries: string[]
}> = [
  {
    name: 'contains',
    file: 'savltree-contains.json',
    whichColl: 'second',
    successEntries: ['contains_key_present', 'contains_key_absent', 'contains_bytes_key_32'],
  },
  {
    name: 'get',
    file: 'savltree-get.json',
    whichColl: 'second',
    successEntries: ['get_key_present', 'get_key_absent', 'get_bytes_key_32'],
  },
  {
    name: 'getMany',
    file: 'savltree-get-many.json',
    whichColl: 'first',
    successEntries: ['get_many_all_present', 'get_many_mixed_2_of_3', 'get_many_all_absent'],
  },
  {
    name: 'insert',
    file: 'savltree-insert.json',
    whichColl: 'first',
    successEntries: ['insert_success_1_entry', 'insert_success_3_entries'],
  },
  {
    name: 'update',
    file: 'savltree-update.json',
    whichColl: 'first',
    successEntries: ['update_success_1_entry', 'update_success_3_entries'],
  },
  {
    name: 'remove',
    file: 'savltree-remove.json',
    whichColl: 'first',
    successEntries: ['remove_success_1_key', 'remove_success_3_keys'],
  },
]

const XOR_PATTERNS = [0xff, 0x01, 0x80]
const THRESHOLD = 0.9

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('SAvlTree mutation testing (Layer C3.a)', () => {
  for (const handler of HANDLERS) {
    describe(`SAvlTree.${handler.name}`, () => {
      const fixture = loadFixture(handler.file)
      const entries = fixture.entries.filter((e) => handler.successEntries.includes(e.name))
      // Aggregate stats across the handler's scenarios for an overall threshold check.
      let aggKilled = 0
      let aggTotal = 0

      for (const entry of entries) {
        it(`${entry.name}: ≥${(THRESHOLD * 100).toFixed(0)}% kill rate on proof-byte mutations`, () => {
          const treeBytes = hexToBytes(entry.tree_bytes_hex)
          const tree = parseTree(treeBytes)
          const region = locateProofRegion(treeBytes, tree, handler.whichColl)

          // Baseline outcome (unmutated).
          const baseline = evalSafely(treeBytes, entry.opts_json)
          expect(baseline.ok).toBe(true)

          let killed = 0
          let total = 0
          for (let i = region.start; i < region.end; i++) {
            for (const xor of XOR_PATTERNS) {
              total++
              const mutated = new Uint8Array(treeBytes)
              mutated[i] = (mutated[i]! ^ xor) & 0xff
              const outcome = evalSafely(mutated, entry.opts_json)
              if (isKill(baseline, outcome, handler.name)) killed++
            }
          }

          const rate = total === 0 ? 1 : killed / total
          // eslint-disable-next-line no-console
          console.log(
            `[mutation] ${handler.name}.${entry.name}: killed=${killed} ` +
              `total=${total} rate=${rate.toFixed(3)} ` +
              `proofLen=${region.proofLen} proofStart=${region.start}`
          )
          aggKilled += killed
          aggTotal += total
          expect(rate).toBeGreaterThanOrEqual(THRESHOLD)
        })
      }

      it(`SAvlTree.${handler.name}: aggregate kill rate ≥${(THRESHOLD * 100).toFixed(0)}%`, () => {
        const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
        // eslint-disable-next-line no-console
        console.log(
          `[mutation] AGG ${handler.name}: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`
        )
        expect(rate).toBeGreaterThanOrEqual(THRESHOLD)
      })
    })
  }
})
