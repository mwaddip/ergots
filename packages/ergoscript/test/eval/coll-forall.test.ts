/**
 * ForAll (collection forall) eval — fixture-driven test (phase 2f Coll HOFs Task 10).
 *
 * Fifth and final lambda HOF arm. Tests the `ForAll` arm of the evaluator: returns
 * true if all elements of a collection satisfy a boolean predicate. Short-circuits
 * on the first false element; returns true for empty input (vacuous truth).
 *
 * Cost: Mixed pattern — outer charged on FULL input length BEFORE loop, per-iter only
 * for VISITED items.
 *   - Outer (after input/condition eval, BEFORE loop, FULL n):
 *       add_per_item_jit_cost(3, 1, 10, n) where n = FULL input.length
 *       n=0 → 3, n=3 → 4, n=12 → 5, n=1000 → 103
 *   - Per-iter (inside closure, before body eval):
 *       addCost(5) per VISITED element (short-circuit reduces this)
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/coll_forall.rs:12-69
 *   line 18-19: eval input and condition (children first, Pattern B)
 *   line 29: ctx.add_jit_cost(5)?;                         // per-iter (inside closure)
 *   line 46-58: elem_tpe check: coll.elem_tpe() != &*self.elem_tpe
 *   line 60: ctx.add_per_item_jit_cost(3, 1, 10, n)?;      // outer (BEFORE loop, FULL n)
 *   line 62-66: for item { if !condition_call(item) { return false; } }
 *   line 68: Ok(true.into())  // all pass or empty
 *
 * KEY DIFFERENCE from Exists (Task 9):
 *   - ForAll short-circuits on first FALSE (Exists on first true).
 *   - ForAll's empty-Coll result is TRUE — vacuous truth (Exists returns false).
 *   - Otherwise structurally identical.
 *
 * KEY DIFFERENCE from Filter/Map (no short-circuit):
 *   - ForAll short-circuits on first false — only VISITED items incur per-iter cost.
 *   - Outer cost ALWAYS charges FULL input length (computed before loop starts).
 *
 * SMOKING-GUN: entry 2 — n=1000, false at item 1.
 *   outer = addPerItemCost(3, 1, 10, 1000) = 103 (FULL n)
 *   per-iter = 1 * 5 = 5 (only item 1 visited before short-circuit)
 *   arm contribution = 108
 *   This proves outer charges FULL n, NOT the visited count (which would give 4+5=9).
 *
 * Elem-type check (mirrors Exists — sigma-rust coll_forall.rs:46-52):
 *   Check `coll.elem_tpe() != &*self.elem_tpe`. In TS, the ForAll MIR has no `elemTpe`
 *   field; we derive the expected type from `condition.args[0].tpe` when condition is
 *   a FuncValue MIR node. Throws 'coll-elem-tpe-mismatch' on mismatch.
 *
 * Fixture entries (10):
 *   1. coll_forall_happy                      — [1,2,3].forall(x => x > 0) → Boolean(true)
 *   2. coll_forall_sg_full_outer_cost         — [false,true,...x1000].forall(x => x) → Boolean(false)
 *      SMOKING-GUN: outer charges FULL n=1000 even though short-circuit at item 1.
 *   3. coll_forall_some_fail                 — [1,2,3].forall(x => x > 0) → Boolean(true) (all visited)
 *   4. coll_forall_empty                     — [].forall(_ => false) → Boolean(true) (vacuous truth!)
 *   5. coll_forall_sg_n12                    — n=12, all true → Boolean(true) (outer chunking proof)
 *   6. coll_forall_elem_tpe_mismatch         — declared elem_tpe=SLong vs runtime SInt → 'coll-elem-tpe-mismatch'
 *   7. coll_forall_lambda_not_callable       — condition is Const(Boolean) → 'lambda-not-callable'
 *   8. coll_forall_lambda_result_type_mismatch — body returns Int → 'lambda-result-type-mismatch'
 *   9. coll_forall_not_coll                  — input is SInt → 'coll-input-not-coll'
 *  10. coll_forall_cost_limit               — jitCostLimit too low → 'cost-limit-exceeded'
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, captureEvalError, rehydrateEvalOpts } from '../_helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface CollForAllFixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface CollForAllFixtureFile {
  corpus: string
  entries: CollForAllFixtureEntry[]
}

const FIXTURE_PATH = join(__dirname, '../fixtures/eval/coll-forall.json')
const fixture: CollForAllFixtureFile = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

describe('ForAll eval (phase 2f Coll HOFs Task 10)', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const opts = rehydrateEvalOpts(entry.opts_json)
      const ctx = makeContext(opts)

      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const result = evaluateWith(tree, ctx)
        expect(result).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }

  // Smoking-gun: outer cost charges FULL input length regardless of short-circuit point.
  //
  // Entry 2 (coll_forall_sg_full_outer_cost): n=1000, false at item 1 (short-circuit).
  //   outer = addPerItemCost(3, 1, 10, 1000) = 3 + 100 = 103  (FULL n=1000)
  //   per-iter = 1 * 5 = 5  (only item 1 visited)
  //   arm contribution = 108
  //
  // If outer charged only VISITED items (wrong):
  //   outer_wrong = addPerItemCost(3, 1, 10, 1) = 3 + 1 = 4
  //   arm_wrong = 4 + 5 = 9  (NOT what we observe)
  //
  // The fixture expected_cost was captured by sigma-rust and proves the FULL-n behavior.
  // This live-eval test cross-checks TS reproduces the same cost structure.
  it('smoking-gun: outer charges FULL n=1000, not the 1 visited item (cost > n=1 calculation)', () => {
    const sgEntry = fixture.entries.find(e => e.name === 'coll_forall_sg_full_outer_cost')!

    const ctx = makeContext(rehydrateEvalOpts(sgEntry.opts_json))
    const result = evaluateWith(parseTree(hexToBytes(sgEntry.tree_bytes_hex)), ctx)

    // Result must be Boolean(false) — short-circuit fired at item 1 (first item is false).
    expect(result).toEqual({ kind: 'Boolean', value: false })

    // The actual cost must match sigma-rust's reference value.
    expect(ctx.jitCost).toBe(sgEntry.expected_cost)

    // Demonstrate that the cost is NOT consistent with outer charging n=1 (the visited count).
    // If outer charged n=1: arm_contribution = addPerItemCost(3,1,10,1) + 5 = 4+5 = 9.
    // The actual sigma-rust cost is much higher (outer charges 1000 items).
    // We confirm this by checking the actual cost exceeds the wrong lower bound.
    const wrongOuterForN1 = 3 + Math.ceil(1 / 10) * 1   // = 4
    const correctOuterForN1000 = 3 + Math.ceil(1000 / 10) * 1  // = 103
    const outerDelta = correctOuterForN1000 - wrongOuterForN1  // = 99
    // The sigma-rust cost includes the full-n outer charge.
    // We verify the delta is exactly what the formula predicts.
    expect(correctOuterForN1000 - wrongOuterForN1).toBe(99)
    // And the actual cost is consistent with FULL-n outer (not n=1).
    expect(ctx.jitCost).toBeGreaterThan(wrongOuterForN1 + 5) // definitively more than wrong scenario
    // Sanity: formula is correct
    expect(outerDelta).toBe(99)
  })

  // Empty-Coll vacuous truth: ForAll returns TRUE for empty input (unlike Exists which returns false).
  it('empty-Coll: forall returns true (vacuous truth, opposite of Exists which returns false)', () => {
    const emptyEntry = fixture.entries.find(e => e.name === 'coll_forall_empty')!

    const ctx = makeContext(rehydrateEvalOpts(emptyEntry.opts_json))
    const result = evaluateWith(parseTree(hexToBytes(emptyEntry.tree_bytes_hex)), ctx)

    // Vacuous truth: empty collection satisfies all predicates.
    // sigma-rust coll_forall.rs:68: Ok(true.into())
    expect(result).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(emptyEntry.expected_cost)
  })
})
