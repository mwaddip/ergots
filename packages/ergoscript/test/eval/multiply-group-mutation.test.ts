/**
 * Layer C3.a — Byte-level mutation testing for the MultiplyGroup arm.
 *
 * For each success-path fixture, mutate the 33-byte SEC1 GroupElement payload
 * of EACH inline `Const(SGroupElement, …)` child (two per tree: left and
 * right). Per `isKillStandard`:
 *   - baseline ok + mutated throws  → kill (decodePoint rejected an
 *                                     off-curve / bad-encoding flip)
 *   - baseline ok + mutated ok      → kill iff values differ
 *                                     (mutated point ≠ baseline result)
 *   - both throw                    → not a kill (excluded — no success-path
 *                                     baseline)
 *
 * Expected behaviour by entry:
 *   - mg_gen_gen / mg_inverse_then_doubling / mg_random_random :
 *     flipping bytes within either point input either yields an off-curve
 *     point (most flips → `decodePoint` throws → kill) or a valid different
 *     point (the sum bytes change → kill).
 *
 *   - mg_gen_identity : left input is generator (mostly off-curve flips →
 *     kill); right input is identity (33 zero bytes — same logic as
 *     dp_identity: most XOR patterns trip the SEC1 validator → kill).
 *
 *   - mg_identity_identity : both inputs are 33 zero bytes. Each byte flip
 *     forces the all-zero short-circuit (isZero33) to fail, then `fromBytes`
 *     rejects the invalid compressed-SEC1 encoding → throw → kill.
 *
 *   - mg_asymmetric : g + (-g) = identity. Flipping bytes of either point
 *     either decodes off-curve (kill) or produces a different point whose
 *     sum with the partner is no longer identity (kill).
 *
 *  ⚠ Potential survivor: in the 0x02 ↔ 0x03 tag flip case, the mutated point
 *  is the y-negation of the original, which causes the sum to change. So
 *  even tag flips kill via value-differ.
 *
 * Threshold: ≥ 0.90 per entry (aggregate fallback accepted).
 *
 * Skipped fixtures:
 *   - error entries (no success-path baseline; explicitly filtered).
 *
 * Source: ergotree-interpreter/src/eval/multiply_group.rs:9-29
 *         ergo-chain-types/src/ec_point.rs:74-80 (Mul<&EcPoint> = ProjectivePoint::add)
 * Pattern: decode-point-mutation.test.ts (shared harness in
 *          test/_helpers/mutation-harness.ts). Custom inline helper for
 *          locating Const(SGroupElement) regions because the shared
 *          `locateInlineCollRegion` is Coll[Byte]-specific.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import type { Expr } from '../../src/mir/types'
import { hexToBytes } from '../_helpers'
import {
  runMutationLoop,
  DEFAULT_KILL_THRESHOLD,
} from '../_helpers/mutation-harness'

/**
 * Find the first occurrence of `needle` in `haystack` at or after `from`.
 * Returns the start offset, or -1 if not found. Unlike the harness's
 * `locateBytes` we don't throw on ambiguity — multiple occurrences are
 * EXPECTED here (mg_gen_gen has two identical generator payloads; the
 * caller advances `from` past each match to walk the list).
 */
function findBytesFrom(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'multiply-group.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

/**
 * Walk `expr` depth-first and collect every inline `Const(SGroupElement, …)`
 * 33-byte payload. MultiplyGroup trees have exactly two: `left` then `right`.
 */
function findInlineGroupElementConsts(expr: Expr): Uint8Array[] {
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
      (n['tpe'] as Record<string, unknown>)['tag'] === 'SGroupElement' &&
      typeof n['value'] === 'object' &&
      n['value'] !== null &&
      (n['value'] as Record<string, unknown>)['kind'] === 'GroupElement'
    ) {
      const v = (n['value'] as Record<string, unknown>)['value']
      if (v instanceof Uint8Array) {
        out.push(v)
      }
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

describe('MultiplyGroup mutation testing (Layer C3.a)', () => {
  // Skip error entries (no success-path baseline).
  const entries = fixture.entries.filter(
    (e) => e.expected_error_code === null || e.expected_error_code === undefined,
  )
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on input-byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const tree = parseTree(treeBytes)
      // MultiplyGroup trees carry exactly two inline GroupElement consts.
      const grpConsts = findInlineGroupElementConsts(tree.body)
      expect(grpConsts.length).toBe(2)

      let entryKilled = 0
      let entryTotal = 0
      // mg_identity_identity has both consts equal (33 zero bytes); mg_gen_gen
      // has identical generator on both sides; mg_gen_identity puts generator
      // on left and identity on right. For all three cases the per-payload
      // search must advance past prior occurrences (`from` cursor) so we mutate
      // EACH wire position independently — the left-input bytes and the
      // right-input bytes are mutated separately, even when they coincide.
      let searchFrom = 0
      for (let i = 0; i < grpConsts.length; i++) {
        const pointBytes = grpConsts[i]!
        const start = findBytesFrom(treeBytes, pointBytes, searchFrom)
        if (start < 0) {
          throw new Error(
            `multiply-group-mutation: ${entry.name} #${i}: payload not found at/after offset ${searchFrom}`,
          )
        }
        const end = start + pointBytes.length
        searchFrom = end // advance so the next iteration finds the NEXT occurrence
        const result = runMutationLoop({
          treeBytes,
          region: { start, end },
          optsJson: entry.opts_json,
        })
        // eslint-disable-next-line no-console
        console.log(
          `[mutation] multiply_group.${entry.name}#${i}: killed=${result.killed} ` +
            `total=${result.total} rate=${result.rate.toFixed(3)} ` +
            `inputLen=${pointBytes.length} inputStart=${start}`,
        )
        entryKilled += result.killed
        entryTotal += result.total
      }
      aggKilled += entryKilled
      aggTotal += entryTotal
      const entryRate = entryTotal === 0 ? 1 : entryKilled / entryTotal
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] multiply_group.${entry.name} TOTAL: killed=${entryKilled} ` +
          `total=${entryTotal} rate=${entryRate.toFixed(3)}`,
      )
      expect(entryRate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`MultiplyGroup: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG multiply_group: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
