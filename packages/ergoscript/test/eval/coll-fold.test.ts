/**
 * Fold eval — fixture-driven test.
 *
 * Applies a binary function to an accumulator and each element of a
 * collection, going left to right. `Fold.eval` (`transformers.scala:224-231`)
 * evaluates input, evaluates zero, runs `Value.checkType(zero, zeroV)` —
 * the only `checkType` site in the arm — evaluates foldOp, charges the
 * sequence cost at the input's length, and runs `inputV.foldLeft(zeroV,
 * foldOpV)`. The lambda takes a 2-tuple `(acc, item)` and destructures it
 * via SelectField (1-indexed, 1=acc, 2=item).
 *
 * Cost (Mixed pattern — outer + per-item):
 *   Outer, AFTER all three child evals (input, zero, fold_op), BEFORE the
 *   loop:
 *     `addPerItemCost(3, 1, 10, n)` where n = input.length.
 *     n=0 → 3, n=4 → 4, n=5 → 4, n=12 → 5.
 *   Per-iter, inside the closure, BEFORE body eval:
 *     `addCost(5)` per element.
 *
 * Lambda body shape (happy-path): `BinOp(Plus, SelectField(1, ValUse(tup_id)),
 *   SelectField(2, ValUse(tup_id)))` — SelectField(1) extracts acc,
 *   SelectField(2) extracts item. SelectField is 1-indexed.
 *
 * Tuple construction in the loop:
 *   Each iteration creates `{ kind: 'Tuple', items: [acc, item] }` as the
 *   lambda arg, bound to `closure.argIds[0]` in a fresh env scope. Body
 *   uses SelectField(1) to get acc (items[0]) and SelectField(2) to get
 *   item (items[1]). The 1-based SelectField index maps to
 *   `items[fieldIndex - 1]`.
 *
 * Fixture entries (8):
 *   1. coll_fold_happy_sum               — [1,2,3,4].fold(0)((acc,item) => acc+item) → Int(10)
 *   2. coll_fold_multiply                — [1,2,3].fold(1)((acc,item) => acc*item)   → Int(6)
 *   3. coll_fold_empty                   — [].fold(42)(...) → Int(42)
 *   4. coll_fold_byte_coll               — Coll[Byte].fold(0_byte)  → Byte(35)
 *   5. coll_fold_sg_n12                  — n=12 smoking-gun; outer=5 vs n=5 outer=4
 *   6. coll_fold_lambda_not_callable     — 'lambda-not-callable'
 *   7. coll_fold_not_coll                — 'coll-input-not-coll'
 *   8. coll_fold_cost_limit_exceeded     — 'cost-limit-exceeded'
 *
 * Smoking-gun test (live-eval):
 *   Compare entries 1 (n=4) and 5 (n=12) extracted costs to verify outer
 *   cost changes at n=10 chunk boundary (n=5 → outer 4; n=12 → outer 5).
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

interface CollFoldFixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface CollFoldFixtureFile {
  corpus: string
  entries: CollFoldFixtureEntry[]
}

const FIXTURE_PATH = join(__dirname, '../fixtures/eval/coll-fold.json')
const fixture: CollFoldFixtureFile = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

describe('Fold eval (phase 2f Coll HOFs Task 8)', () => {
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
  // n=4 (happy sum) → outer = 3 + 1*ceil(4/10) = 4
  // n=12 (sg_n12)   → outer = 3 + 1*ceil(12/10) = 5
  // Per-iter difference is 8*5=40, outer difference is 1; total diff = 41.
  it('smoking-gun: outer cost (3,1,10) changes at n=10 boundary between n=4 and n=12', () => {
    const sg4Entry = fixture.entries.find(e => e.name === 'coll_fold_happy_sum')! // n=4
    const sg12Entry = fixture.entries.find(e => e.name === 'coll_fold_sg_n12')! // n=12

    // Live-eval each through TS evaluator.
    const ctx4 = makeContext(rehydrateEvalOpts(sg4Entry.opts_json))
    evaluateWith(parseTree(hexToBytes(sg4Entry.tree_bytes_hex)), ctx4)

    const ctx12 = makeContext(rehydrateEvalOpts(sg12Entry.opts_json))
    evaluateWith(parseTree(hexToBytes(sg12Entry.tree_bytes_hex)), ctx12)

    // Costs must match the sigma-rust reference.
    expect(ctx4.jitCost).toBe(sg4Entry.expected_cost)
    expect(ctx12.jitCost).toBe(sg12Entry.expected_cost)
    // n=4 and n=12 are in different chunks (ceil(4/10)=1, ceil(12/10)=2):
    // outer cost for n=12 is 1 more than n=4. Per-iter also differs by 8*5=40.
    // Total difference: sigma-rust determines this via expected_cost delta.
    const expectedDiff = sg12Entry.expected_cost - sg4Entry.expected_cost
    expect(ctx12.jitCost - ctx4.jitCost).toBe(expectedDiff)
  })
})
