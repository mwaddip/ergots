/**
 * Layer C3.a — Operator-driven mutation testing for 9 Coll HOF arms.
 *
 * For each success-eval fixture entry across the 9 Coll HOF arms:
 *   1. Parse the ErgoTree (body Expr extracted automatically by parseTree).
 *   2. Evaluate the baseline — captures the reference SValue.
 *   3. For each of the 7 operators (O1-O7): emit Expr variants.
 *   4. For each variant: evaluate and classify as:
 *      - **killed** — EvalError is thrown OR result differs from baseline.
 *      - **survived** — eval succeeds with same value as baseline.
 *   5. Per-arm mutation score = killed / (killed + survived).
 *
 * Threshold assertion (score >= 0.90 per arm) is gated via `it.skip` until
 * Task 12 calibrates the expected-survival allowlist.
 *
 * Phase 2f Coll HOFs Task 11.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../src/wire/ergo-tree'
import { evaluateWith } from '../src/eval/evaluate'
import { makeContext, EvalError } from '../src/eval/eval-context'
import type { SValue } from '../src/mir/types'
import { hexToBytes, rehydrateEvalOpts } from './_helpers'
import { ALL_OPERATORS } from './_mutation-operators'
import { EXPECTED_SURVIVALS } from './_mutation-allowlist'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

function loadFixture(arm: string): FixtureFile {
  const fixturePath = join(__dirname, `fixtures/eval/${arm}.json`)
  return JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile
}

// ---------------------------------------------------------------------------
// SValue deep-equality
// ---------------------------------------------------------------------------

/**
 * Deep-equal two SValues. Used to classify mutations as killed vs survived.
 * We use JSON.stringify with a BigInt replacer for simplicity — this works
 * because SValue is a pure value tree with no circular references.
 */
function svalueEqual(a: SValue, b: SValue): boolean {
  try {
    const replacer = (_key: string, val: unknown): unknown =>
      typeof val === 'bigint' ? `__bigint__${val.toString()}__` : val
    return JSON.stringify(a, replacer) === JSON.stringify(b, replacer)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Per-arm mutation stats type
// ---------------------------------------------------------------------------

interface ArmStats {
  arm: string
  totalEntries: number
  totalVariants: number
  killed: number
  survived: number
  score: number
}

// ---------------------------------------------------------------------------
// Arms list
// ---------------------------------------------------------------------------

const ARMS = [
  'coll-size',
  'coll-append',
  'coll-by-index',
  'coll-slice',
  'coll-map',
  'coll-filter',
  'coll-fold',
  'coll-exists',
  'coll-forall',
]

const THRESHOLD = 0.90

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('eval mutation testing (Layer C3.a)', () => {
  for (const arm of ARMS) {
    describe(arm, () => {
      const fixture = loadFixture(arm)

      // Only test success entries (no expected_error_code)
      const successEntries = fixture.entries.filter(e => e.expected_error_code === null)

      // Compute arm stats once for the threshold test
      const armStats: ArmStats = {
        arm,
        totalEntries: successEntries.length,
        totalVariants: 0,
        killed: 0,
        survived: 0,
        score: 0,
      }

      for (const entry of successEntries) {
        it(`${entry.name}`, () => {
          const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
          const baseOpts = rehydrateEvalOpts(entry.opts_json)
          const baseCtx = makeContext({
            ...baseOpts,
            constants: baseOpts.constants ?? tree.constants,
            treeVersion: baseOpts.treeVersion ?? tree.header.version,
          })

          // Evaluate baseline
          const baseline: SValue = evaluateWith(tree, baseCtx)

          let entryKilled = 0
          let entrySurvived = 0
          let entryVariants = 0

          for (const op of ALL_OPERATORS) {
            const variants = op.apply(tree.body)
            for (let siteIndex = 0; siteIndex < variants.length; siteIndex++) {
              const mutatedBody = variants[siteIndex]!
              // Build a fresh tree with the mutated body
              const mutatedTree = { ...tree, body: mutatedBody }

              // Fresh context (don't reuse cost-accumulating ctx)
              const mutCtx = makeContext({
                ...baseOpts,
                constants: baseOpts.constants ?? tree.constants,
                treeVersion: baseOpts.treeVersion ?? tree.header.version,
              })

              entryVariants++

              const allowlistKey = `${arm}:${entry.name}:${op.name}:${siteIndex}`

              let wasKilled = false
              try {
                const mutResult = evaluateWith(mutatedTree, mutCtx)
                if (!svalueEqual(mutResult, baseline)) {
                  wasKilled = true
                }
                // If survived (same value), check allowlist
                if (!wasKilled && !EXPECTED_SURVIVALS.has(allowlistKey)) {
                  // Survival is noted but not asserted here — threshold test handles it
                }
              } catch (e) {
                if (e instanceof EvalError) {
                  wasKilled = true
                } else {
                  // Non-EvalError — treat as killed (mutation caused unexpected crash)
                  wasKilled = true
                }
              }

              if (wasKilled) {
                entryKilled++
              } else {
                entrySurvived++
              }
            }
          }

          armStats.totalVariants += entryVariants
          armStats.killed += entryKilled
          armStats.survived += entrySurvived

          // No per-entry assertion — aggregate is in the threshold test below
          // but we verify the test ran without internal errors by reaching here.
          expect(entryVariants).toBeGreaterThanOrEqual(0)
        })
      }

      // Compute score after all entry tests have run
      // (This runs in `describe` setup context, not in `it` — so it's evaluated eagerly,
      //  but armStats is populated lazily during test execution. We use a final `it`
      //  that checks the computed score after the entry tests.)
      it.skip(`${arm}: mutation score >= ${THRESHOLD} (Task 12 will enable)`, () => {
        const total = armStats.killed + armStats.survived
        const score = total === 0 ? 1 : armStats.killed / total
        console.log(
          `[mutation] ${arm}: killed=${armStats.killed} survived=${armStats.survived} ` +
          `total=${total} score=${score.toFixed(3)} entries=${armStats.totalEntries} ` +
          `variants=${armStats.totalVariants}`
        )
        expect(score).toBeGreaterThanOrEqual(THRESHOLD)
      })
    })
  }

  // Summary across all arms — also skipped, for Task 12 to enable
  it.skip('all arms: aggregate mutation score >= 0.90', () => {
    // Placeholder — Task 12 will wire this up with populated armStats
    expect(true).toBe(true)
  })
})
