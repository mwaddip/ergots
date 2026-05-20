import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

describe('evalExpr (central dispatch — chassis only)', () => {
  it('throws not-implemented-yet for any unwired variant', () => {
    // Use DecodePoint as a representative — `Xor` was wired in Task T7
    // (phase 2i-a pure-bytes predefs), so we pick the next still-unported
    // variant. The expr shape is irrelevant to the dispatch path; only the
    // `tag` matters before the default arm fires.
    const inputExpr: Expr = {
      tag: 'Const',
      tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
      value: { kind: 'Coll', elem: { tag: 'SByte' }, items: [] },
    }
    const e: Expr = { tag: 'DecodePoint', input: inputExpr }
    const err = captureEvalError(() => evalExpr(e, Env.empty(), makeContext()))
    expect(err.code).toBe('not-implemented-yet')
    expect(err.message).toContain("'DecodePoint'")
  })
})
