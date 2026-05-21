import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

describe('evalExpr (central dispatch — chassis only)', () => {
  it('throws not-implemented-yet for any unwired variant', () => {
    // Use SubstConstants as a representative — `DecodePoint` was wired in
    // Task T8 (phase 2i-a pure-bytes predefs), so we pick the next still-
    // unported variant. SubstConstants is the last 2i-a arm (T9) and remains
    // unwired until that task lands. The expr shape is irrelevant to the
    // dispatch path; only the `tag` matters before the default arm fires.
    const placeholderColl: Expr = {
      tag: 'Const',
      tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
      value: { kind: 'Coll', elem: { tag: 'SByte' }, items: [] },
    }
    const placeholderIntColl: Expr = {
      tag: 'Const',
      tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
      value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [] },
    }
    const e: Expr = {
      tag: 'SubstConstants',
      scriptBytes: placeholderColl,
      positions: placeholderIntColl,
      newValues: placeholderColl,
    }
    const err = captureEvalError(() => evalExpr(e, Env.empty(), makeContext()))
    expect(err.code).toBe('not-implemented-yet')
    expect(err.message).toContain("'SubstConstants'")
  })
})
