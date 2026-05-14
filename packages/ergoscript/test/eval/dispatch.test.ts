import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'

describe('evalExpr (central dispatch — chassis only)', () => {
  it('throws not-implemented-yet for any variant in 2b chassis state', () => {
    // Use Const as a representative — we know the tag is in the union but
    // no arm is wired yet. Will be replaced as Tasks 8+ wire each arm.
    const e: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } }
    expect(() => evalExpr(e, Env.empty(), makeContext())).toThrow(EvalError)
    try {
      evalExpr(e, Env.empty(), makeContext())
    } catch (err) {
      expect(err).toBeInstanceOf(EvalError)
      expect((err as EvalError).code).toBe('not-implemented-yet')
      expect((err as EvalError).message).toContain("'Const'")
    }
  })
})
