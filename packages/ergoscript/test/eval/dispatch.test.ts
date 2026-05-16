import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

describe('evalExpr (central dispatch — chassis only)', () => {
  it('throws not-implemented-yet for any unwired variant', () => {
    // Use Fold as a representative — `Filter` was wired in Task 7 (phase
    // 2f Coll HOFs), so we pick the next still-unported variant. The expr
    // shape is irrelevant to the dispatch path; only the `tag` matters before
    // the default arm fires.
    const innerColl: Expr = {
      tag: 'Const',
      tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
      value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
    }
    const zeroExpr: Expr = {
      tag: 'Const',
      tpe: { tag: 'SInt' },
      value: { kind: 'Int', value: 0 },
    }
    const foldOpExpr: Expr = {
      tag: 'Const',
      tpe: { tag: 'SBoolean' },
      value: { kind: 'Boolean', value: true },
    }
    const e: Expr = { tag: 'Fold', input: innerColl, zero: zeroExpr, foldOp: foldOpExpr }
    const err = captureEvalError(() => evalExpr(e, Env.empty(), makeContext()))
    expect(err.code).toBe('not-implemented-yet')
    expect(err.message).toContain("'Fold'")
  })
})
