/**
 * Map (collection map) eval — fixture-driven test (phase 2f Coll HOFs Task 6).
 *
 * First lambda HOF arm. Tests the `Map` arm of the evaluator: applies a
 * function to each element of a collection, returning a new collection.
 *
 * Cost: Mixed pattern — outer + per-item.
 *   - Outer (after input/mapper eval, before loop):
 *       add_per_item_jit_cost(20, 1, 10, n) where n = input.length
 *       n=0 → 20, n=5 → 21, n=12 → 22
 *   - Per-iter (inside closure, before body eval):
 *       addCost(5) per element
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/coll_map.rs:14-84
 *   line 20: input_v = self.input.eval(env, ctx)?;
 *   line 21: mapper_v = self.mapper.eval(env, ctx)?;
 *   line 31: ctx.add_jit_cost(5)?;   // per-iter, inside closure
 *   line 72: ctx.add_per_item_jit_cost(20, 1, 10, n)?;  // outer
 *
 * Env-extend pattern (first lambda HOF — establishes convention for Tasks 7-10):
 *   - Env is immutable in TS (per phase 2b design).
 *   - For each item, extend env with (closure.argIds[0], item) and eval body.
 *   - This mirrors sigma-rust's mutable env.insert + env.remove dance
 *     (coll_map.rs:30-38) but without save/restore overhead.
 *
 * Fixture entries (9):
 *   1. coll_map_happy      — [1,2,3,4].map(x => x+1) → [2,3,4,5]
 *   2. coll_map_empty      — [].map(x => x+1) → []   (outer cost only, n=0)
 *   3. coll_map_sg_n5      — [0..5].map(x=>x) → [0..5]  (outer=21)
 *   4. coll_map_sg_n12     — [0..12].map(x=>x) → [0..12] (outer=22)
 *      (entries 3+4: outer cost 21 vs 22 — proves chunked outer)
 *   5. coll_map_not_coll   — Map(Int, mapper) → 'coll-input-not-coll'
 *   6. coll_map_cost_limit — cost-limit-exceeded
 *   7. coll_map_elem_tpe_mismatch        — Coll[Int] × lambda t_dom: SLong → 'coll-elem-tpe-mismatch'
 *   8. coll_map_lambda_not_callable      — mapper is Const(SInt,42) → 'lambda-not-callable'
 *   9. coll_map_lambda_result_type_mismatch — If body t=SInt but false-branch=Boolean → 'lambda-result-type-mismatch'
 *
 * Smoking-gun test (live-eval):
 *   Compare entries 3 and 4 extracted costs to verify outer cost changes
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

interface CollMapFixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface CollMapFixtureFile {
  corpus: string
  entries: CollMapFixtureEntry[]
}

const FIXTURE_PATH = join(__dirname, '../fixtures/eval/coll-map.json')
const fixture: CollMapFixtureFile = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

describe('Map eval (phase 2f Coll HOFs Task 6)', () => {
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
  // Difference from identity body (ValUse cost=5) and per-iter cost (5):
  //   n=5:  5(Const) + 5(FuncValue) + 21(outer) + 5*10(per-iter + body) = 81
  //   n=12: 5(Const) + 5(FuncValue) + 22(outer) + 12*10(per-iter + body) = 152
  // This live-eval test compares the actual TS evaluator costs (not just fixture
  // expected_cost) to prove the evaluator correctly implements the chunked outer.
  it('smoking-gun: outer cost changes at n=10 boundary (n=5 → 81, n=12 → 152)', () => {
    const sg5Entry = fixture.entries.find(e => e.name === 'coll_map_sg_n5')!
    const sg12Entry = fixture.entries.find(e => e.name === 'coll_map_sg_n12')!

    // Live-eval each through TS evaluator.
    const ctx5 = makeContext(rehydrateEvalOpts(sg5Entry.opts_json))
    evaluateWith(parseTree(hexToBytes(sg5Entry.tree_bytes_hex)), ctx5)

    const ctx12 = makeContext(rehydrateEvalOpts(sg12Entry.opts_json))
    evaluateWith(parseTree(hexToBytes(sg12Entry.tree_bytes_hex)), ctx12)

    // n=5 and n=12 are in different chunks (ceil(5/10)=1, ceil(12/10)=2),
    // so the outer cost contribution must differ.
    // n=5 outer arm contribution: 21 + 5*5 = 46  (plus shared eval costs)
    // n=12 outer arm contribution: 22 + 5*12 = 82 (plus shared eval costs)
    // Full costs: 81 vs 152.
    expect(ctx5.jitCost).toBe(sg5Entry.expected_cost)
    expect(ctx12.jitCost).toBe(sg12Entry.expected_cost)
    // Outer cost for n=12 is 1 more than n=5 (proves chunk boundary was crossed).
    // The per-iter difference is 7*10=70, outer difference is 1; total diff = 71.
    expect(ctx12.jitCost - ctx5.jitCost).toBe(71)
  })
})
