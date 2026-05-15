/**
 * BinOp.Relation ordering family — fixture-driven evaluation tests.
 *
 * Four ordering ops: Lt, Le, Gt, Ge. Operate on numeric types
 * (Byte/Short/Int/Long/BigInt). Both operands always evaluate (no
 * short-circuit). Result is always Boolean.
 *
 * Cost: Fixed(20) envelope per sigma-rust bin_op.rs:205-211:
 *   BinOpKind::Relation(op) => match op {
 *       RelationOp::Eq | RelationOp::NEq => {}  // cost charged inside eq_with_cost
 *       _ => { ctx.add_jit_cost(20)?; }  // LT, LE, GT, GE = Fixed(20)
 *   }
 * Total for Const+Const: 20 (envelope) + 5 (left Const) + 5 (right Const) = 30.
 *
 * Error cases:
 *   - 'bin-op-not-numeric': non-numeric operand (e.g. Boolean).
 *   - 'bin-op-kind-mismatch': left and right are different numeric kinds.
 *
 * NOTE: Eq/NEq are NOT in this fixture. They remain 'not-implemented-yet'
 * and are implemented in Task 7 alongside the sValueEquals recursive comparer.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/bin-op-relation.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: any
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('BinOp.Relation ordering family — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ jitCostLimit: entry.opts_json.jitCostLimit })
      if (entry.expected_error_code !== null) {
        expect(() => evaluateWith(tree, ctx)).toThrow(EvalError)
        try {
          evaluateWith(tree, ctx)
        } catch (e) {
          expect((e as EvalError).code).toBe(entry.expected_error_code)
        }
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
