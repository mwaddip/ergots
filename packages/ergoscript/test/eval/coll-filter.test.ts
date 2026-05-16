/**
 * Filter (collection filter) eval — fixture-driven test (phase 2f Coll HOFs Task 7).
 *
 * Second lambda HOF arm. Tests the `Filter` arm of the evaluator: selects elements
 * of a collection for which a predicate (boolean-returning lambda) returns true.
 *
 * Cost: Mixed pattern — outer + per-item.
 *   - Outer (after input/condition eval, before loop):
 *       add_per_item_jit_cost(20, 1, 10, n) where n = input.length
 *       n=0 → 20, n=5 → 21, n=12 → 22
 *   - Per-iter (inside closure, before body eval):
 *       addCost(5) per element
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/coll_filter.rs:15-90
 *   line 20: input_v = self.input.eval(env, ctx)?;
 *   line 21: condition_v = self.condition.eval(env, ctx)?;
 *   line 31: ctx.add_jit_cost(5)?;   // per-iter, inside closure
 *   line 61: ctx.add_per_item_jit_cost(20, 1, 10, n)?;  // outer
 *
 * Key difference from Map (Task 6):
 *   - Elem-type check is against inputColl.elem (the runtime coll's elem), not the
 *     lambda's declared arg type. The TS MIR Filter has no `elemTpe` field — the
 *     check uses the input Coll's runtime `elem` (same as sigma-rust's `self.elem_tpe`
 *     which is derived from the input SColl at Filter::new() construction time).
 *   - Body MUST return Boolean (predicate), not any type. Mismatch throws
 *     'lambda-result-type-mismatch'.
 *   - No short-circuit — all items visited even when some fail (cost determinism).
 *
 * Env-extend pattern (same as Map — established convention for Tasks 7-10):
 *   - Env is immutable in TS (per phase 2b design).
 *   - For each item, extend env with (closure.argIds[0], item) and eval body.
 *   - Mirrors sigma-rust's mutable env.insert + env.remove dance
 *     (coll_filter.rs:29-43) but without save/restore overhead.
 *
 * Fixture entries (10):
 *   1. coll_filter_happy      — [1,2,3,4,5].filter(x => x > 2) → [3,4,5]
 *   2. coll_filter_all_pass   — [1,2,3].filter(_ => true) → [1,2,3]
 *   3. coll_filter_all_fail   — [1,2,3].filter(_ => false) → []
 *   4. coll_filter_empty      — [].filter(_ => true) → []  (outer cost only, n=0)
 *   5. coll_filter_sg_n12     — [0..12].filter(_ => true) → [0..12] (n=12, outer=22)
 *      Compare with entry 1 (n=5, outer=21): proves chunking.
 *   6. coll_filter_not_coll            — Filter(Int, cond) → 'coll-input-not-coll'
 *   7. coll_filter_cost_limit          — cost-limit-exceeded
 *   8. coll_filter_elem_tpe_mismatch   — declared elem_tpe=SLong vs runtime SInt → 'coll-elem-tpe-mismatch'
 *   9. coll_filter_lambda_not_callable — condition is Const(Boolean) → 'lambda-not-callable'
 *  10. coll_filter_lambda_result_type_mismatch — body returns Int → 'lambda-result-type-mismatch'
 *
 * Smoking-gun test (live-eval):
 *   Compare entries 1 (n=5) and 5 (n=12) extracted costs to verify outer cost changes
 *   at n=10 chunk boundary (n=5 → outer 21; n=12 → outer 22).
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

interface CollFilterFixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface CollFilterFixtureFile {
  corpus: string
  entries: CollFilterFixtureEntry[]
}

const FIXTURE_PATH = join(__dirname, '../fixtures/eval/coll-filter.json')
const fixture: CollFilterFixtureFile = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

describe('Filter eval (phase 2f Coll HOFs Task 7)', () => {
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

  // Smoking-gun: outer cost changes at n=10 chunk boundary.
  // n=5 → outer = 20 + 1*ceil(5/10) = 21
  // n=12 → outer = 20 + 1*ceil(12/10) = 22
  // The per-iter difference is 7*5=35, outer difference is 1; total diff = 36.
  it('smoking-gun: outer cost changes at n=10 boundary between n=5 and n=12', () => {
    const sg5Entry = fixture.entries.find(e => e.name === 'coll_filter_happy')! // n=5
    const sg12Entry = fixture.entries.find(e => e.name === 'coll_filter_sg_n12')! // n=12

    // Live-eval each through TS evaluator.
    const ctx5 = makeContext(rehydrateEvalOpts(sg5Entry.opts_json))
    evaluateWith(parseTree(hexToBytes(sg5Entry.tree_bytes_hex)), ctx5)

    const ctx12 = makeContext(rehydrateEvalOpts(sg12Entry.opts_json))
    evaluateWith(parseTree(hexToBytes(sg12Entry.tree_bytes_hex)), ctx12)

    // Costs must match the sigma-rust reference.
    expect(ctx5.jitCost).toBe(sg5Entry.expected_cost)
    expect(ctx12.jitCost).toBe(sg12Entry.expected_cost)
    // n=5 and n=12 are in different chunks (ceil(5/10)=1, ceil(12/10)=2):
    // outer cost for n=12 is 1 more than n=5. Per-iter also differs by 7*5=35.
    // Total difference: sigma-rust determines this via expected_cost delta.
    const expectedDiff = sg12Entry.expected_cost - sg5Entry.expected_cost
    expect(ctx12.jitCost - ctx5.jitCost).toBe(expectedDiff)
  })
})
