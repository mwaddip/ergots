/**
 * `Append` evaluator — fixture-driven test.
 *
 * Source: `data/shared/src/main/scala/sigma/ast/transformers.scala:59-70`
 * at sigma-state 6.0.7. Cost `PerItemCost(baseCost = 20, perChunkCost = 2,
 * chunkSize = 100)` (:76), nItems = inputV.length + col2V.length, charged
 * before the operation by `addSeqCost` (`interpreter/shared/src/main/scala/
 * sigmastate/interpreter/CErgoTreeEvaluator.scala:370-392`).
 *
 * Entries:
 *   1. coll_append_int_4_4          — [1,2,3,4] ++ [5,6,7,8] → [1,2,3,4,5,6,7,8], cost=102
 *   2. coll_append_empty_lhs        — [] ++ [1,2,3] → [1,2,3], cost=77
 *   3. coll_append_empty_rhs        — [1,2,3] ++ [] → [1,2,3], cost=77
 *   4. coll_append_both_empty       — [] ++ [] → [], cost=60
 *   5. coll_append_byte             — Coll[Byte] append → Coll[Byte], cost=52
 *   6. coll_append_cost_eq_lhs      — [1..100] ++ [] → cost=562
 *   7. coll_append_cost_eq_rhs      — [] ++ [1..100] → cost=562 (same as 6)
 *   8. coll_append_elem_tpe_mismatch — Coll[Int] ++ Coll[Long] → 'coll-array-store'
 *                                      (`CollsOverArrays.scala:48-57`: a non-empty
 *                                      plain primitive receiver meets an operand
 *                                      of another primitive array; `safeConcatArrays_v5`
 *                                      refuses the copy before any item is read.)
 *   9. coll_append_not_coll          — Append(Const(Int,42), Coll[Int]([])) rejected at parse.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { ExprTpeError } from '../../src/mir/expr-tpe'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, captureEvalError, rehydrateEvalOpts, withoutClass } from '../_helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface CollAppendFixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface CollAppendFixtureFile {
  corpus: string
  entries: CollAppendFixtureEntry[]
}

const FIXTURE_PATH = join(__dirname, '../fixtures/eval/coll-append.json')
const fixture: CollAppendFixtureFile = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

// An entry whose tree the JVM rejects at parse, as ergots does since 2026-09-30: Append casts its
// input's type to SCollection as it is built (transformers.scala:62; wire/check-build.ts). Its
// expected_error_code is sigma-rust's, which evaluates the tree. A local sigma-state 6.0.6 probe
// rejects it at parse, with and without checkType: ClassCastException.
const PARSE_REJECTS: Record<string, string> = {
  coll_append_not_coll: 'append-input-not-scoll',
}

describe('Append eval (phase 2f Coll HOFs Task 3)', () => {
  for (const entry of fixture.entries) {
    const atParse = PARSE_REJECTS[entry.name]
    if (atParse !== undefined) {
      it(`${entry.name}: ${atParse} at parse`, () => {
        let err: unknown
        try {
          parseTree(hexToBytes(entry.tree_bytes_hex))
        } catch (e) {
          err = e
        }
        expect(err).toBeInstanceOf(ExprTpeError)
        expect((err as ExprTpeError).code).toBe(atParse)
      })
      continue
    }
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const opts = rehydrateEvalOpts(entry.opts_json)
      const ctx = makeContext(opts)

      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const result = evaluateWith(tree, ctx)
        expect(withoutClass(result)).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }

  it('cost-equality smoking-gun: n1+n2=100 is symmetric', () => {
    const lhsEntry = fixture.entries.find(e => e.name === 'coll_append_cost_eq_lhs')!
    const rhsEntry = fixture.entries.find(e => e.name === 'coll_append_cost_eq_rhs')!
    expect(lhsEntry.expected_cost).toBe(rhsEntry.expected_cost)
  })
})
