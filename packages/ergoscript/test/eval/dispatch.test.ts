import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

describe('evalExpr (central dispatch — chassis only)', () => {
  it('throws not-implemented-yet for any unwired variant', () => {
    // Use Xor as a representative — `ForAll` was wired in Task 10 (phase
    // 2f Coll HOFs), so we pick the next still-unported variant. The expr
    // shape is irrelevant to the dispatch path; only the `tag` matters before
    // the default arm fires.
    const leftExpr: Expr = {
      tag: 'Const',
      tpe: { tag: 'SBoolean' },
      value: { kind: 'Boolean', value: true },
    }
    const rightExpr: Expr = {
      tag: 'Const',
      tpe: { tag: 'SBoolean' },
      value: { kind: 'Boolean', value: false },
    }
    const e: Expr = { tag: 'Xor', left: leftExpr, right: rightExpr }
    const err = captureEvalError(() => evalExpr(e, Env.empty(), makeContext()))
    expect(err.code).toBe('not-implemented-yet')
    expect(err.message).toContain("'Xor'")
  })
})
