/**
 * BinOp.Logical family — fixture-driven evaluation tests.
 *
 * Three Boolean binary ops: And and Or short-circuit (non-evaluated branch's
 * cost NOT charged); Xor is eager (both sides always evaluated).
 *
 * Cost: Fixed(20) envelope per sigma-rust bin_op.rs:212-214:
 *   BinOpKind::Logical(_) => { ctx.add_jit_cost(20)?; }
 *
 * Short-circuit proof (fixture-level): cost differential in truth table.
 * And(false, true) costs 25 = envelope(20) + left_Const(5); right NOT charged.
 * And(true, true) costs 30 = envelope(20) + left_Const(5) + right_Const(5).
 * The difference of 5 (one Const) proves the right branch was skipped.
 *
 * Short-circuit proof (inline test below): And(false, ConstPlaceholder(99))
 * with empty constants table. If the placeholder were evaluated, it would
 * throw 'const-placeholder-id-out-of-range'. The tree evaluates to false
 * without throwing — proving right was never touched.
 *
 * NOTE: The TS parser validates placeholder ids at parse time; therefore
 * out-of-range ConstPlaceholder trees cannot be loaded via parseTree. The
 * inline test uses direct evalExpr on a hand-constructed Expr instead.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs:212-235
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { BinOp, Expr } from '../../src/mir/types'
import { hexToBytes, hydrateSValue } from '../_helpers'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/bin-op-logical.json')

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

describe('BinOp.Logical family — fixture-driven', () => {
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

// ---------------------------------------------------------------------------
// Short-circuit semantic — inline tests
//
// These use hand-constructed Expr nodes with out-of-range ConstPlaceholder(99)
// as the right operand. If short-circuit works, the placeholder is never
// evaluated, no error is thrown, and cost = 25 (envelope=20 + left_Const=5).
//
// Why bypass parseTree: the TS parser validates placeholder ids against
// constantTypes.length at parse time. With empty constants, id=99 fails
// at parse. Direct evalExpr bypasses this check, matching sigma-rust's
// eval-time-only validation.
// ---------------------------------------------------------------------------
describe('BinOp.Logical short-circuit — inline semantic tests', () => {
  const boolConst = (b: boolean): Expr => ({
    tag: 'Const',
    tpe: { tag: 'SBoolean' },
    value: { kind: 'Boolean', value: b },
  })

  // ConstPlaceholder(id=99) with SBoolean type.
  // With ctx.constants=[], evaluating this throws 'const-placeholder-id-out-of-range'.
  const outOfRangePlaceholder: Expr = {
    tag: 'ConstPlaceholder',
    id: 99,
    tpe: { tag: 'SBoolean' },
  }

  it('And(false, ConstPlaceholder(99)) evaluates to false WITHOUT throwing', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Logical', op: 'And' },
      left: boolConst(false),
      right: outOfRangePlaceholder,
    }
    // Empty constants table: ConstPlaceholder(99) would throw if evaluated.
    const ctx = makeContext({ constants: [] })
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Boolean', value: false })
    // Cost: 20 (envelope) + 5 (left Const) = 25. Right NOT charged.
    expect(ctx.jitCost).toBe(25)
  })

  it('Or(true, ConstPlaceholder(99)) evaluates to true WITHOUT throwing', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Logical', op: 'Or' },
      left: boolConst(true),
      right: outOfRangePlaceholder,
    }
    const ctx = makeContext({ constants: [] })
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Boolean', value: true })
    // Cost: 20 (envelope) + 5 (left Const) = 25. Right NOT charged.
    expect(ctx.jitCost).toBe(25)
  })
})
