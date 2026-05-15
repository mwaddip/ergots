/**
 * FuncValue arm — inline tests (no fixture file).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/func_value.rs:10-18
 *   ctx.add_jit_cost(5)?; // FuncValue = Fixed(5)
 *   Ok(Value::Lambda(Lambda { args: self.args().to_vec(), body: self.body().clone().into() }))
 *
 * Lambda values aren't directly serializable via fixture-gen's
 * value_to_json helper. Tests construct a FuncValue MIR node by hand,
 * eval it, and assert SValue.kind === 'Lambda' + closure structure.
 *
 * Cost-charging: Fixed(5) BEFORE returning the Lambda (sigma-rust line
 * 12).
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { FuncValue } from '../../src/mir/types'

describe('FuncValue arm — inline', () => {
  it('returns Lambda SValue with cost 5', () => {
    const expr: FuncValue = {
      tag: 'FuncValue',
      args: [{ id: 1, tpe: { tag: 'SInt' } }],
      body: {
        tag: 'ValUse',
        valId: 1,
        tpe: { tag: 'SInt' },
      },
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value.kind).toBe('Lambda')
    if (value.kind === 'Lambda') {
      expect(value.closure.argIds).toEqual([1])
      expect(value.closure.body).toEqual(expr.body)
      // capturedEnv is empty for sigma-rust-style dynamic scoping
      // (env-at-apply-site is used for body lookup, not env-at-definition).
      expect(value.closure.capturedEnv).toEqual({})
    }
    expect(ctx.jitCost).toBe(5)
  })

  it('multi-arg lambda preserves arg ids', () => {
    const expr: FuncValue = {
      tag: 'FuncValue',
      args: [
        { id: 1, tpe: { tag: 'SInt' } },
        { id: 2, tpe: { tag: 'SBoolean' } },
      ],
      body: { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } },
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value.kind).toBe('Lambda')
    if (value.kind === 'Lambda') {
      expect(value.closure.argIds).toEqual([1, 2])
    }
    expect(ctx.jitCost).toBe(5)
  })
})
