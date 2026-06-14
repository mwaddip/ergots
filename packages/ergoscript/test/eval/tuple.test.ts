/**
 * Tuple arm — fixture-driven evaluation tests.
 *
 * Each fixture entry serializes an `Expr::Tuple(items)` (no constant
 * segregation — items are inline `Expr::Const`). For arity-2 pairs we assert
 * the evaluator returns a `{ kind: 'Tuple', items: [...] }` SValue and charges:
 *
 *     sum of item costs  +  15 (envelope, AFTER items per values.scala:806)
 *
 * For arity-2 fixtures every item is a Const (cost 5), so a 2-tuple is 25.
 *
 * For arity ≠ 2, JVM values.scala:795-798 ("Invalid tuple") throws BEFORE
 * any item eval and BEFORE the Fixed(15) envelope. The fixture records
 * `expected_error_code: "tuple-invalid-arity"` and `expected_value_json: null`.
 *
 * The arity-3 entry (tuple_triple_bool_byte_short) was originally accepted
 * by the sigma-rust-inherited arm; flipped to errored in F5 batch-1 to match
 * JVM canonical semantics. SANTA pin: Tuple.non_pair_arity3.json.
 *
 * Long / BigInt items come across as decimal strings in the fixture JSON
 * (no native bigint literal in JSON) and are rehydrated to `bigint` here
 * recursively so the deep-equal comparison succeeds against the SValue
 * union.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, captureEvalError } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/tuple.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: any
  expected_cost: number | null
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('Tuple arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(entry.opts_json)
      if (entry.expected_error_code !== null) {
        // values.scala:795-798: arity≠2 throws BEFORE items + cost (zero cost contribution).
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err).toBeInstanceOf(EvalError)
        expect(err.code).toBe(entry.expected_error_code)
        expect(ctx.jitCost).toBe(0)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
