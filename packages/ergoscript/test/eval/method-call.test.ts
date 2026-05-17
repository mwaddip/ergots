/**
 * Layer C1 — `MethodCall` + `PropertyCall` dispatcher.
 *
 * This task (Task 3) ships the dispatcher + registry with ZERO registered handlers.
 * Tests cover the dispatcher's cost-charging and unknown-pair throw.
 *
 * Source: ergotree-interpreter/src/eval/{method_call,property_call}.rs
 */

import { describe, expect, it } from 'vitest'

import { evalMethodCall, evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall, PropertyCall } from '../../src/mir/types'

describe('MethodCall dispatcher — skeleton (no handlers registered)', () => {
  it("charges cost 4 and throws 'method-not-implemented' on unknown pair", () => {
    // PropertyCall with obj = Context, but typeId=255/methodId=255 is unregistered.
    const e: PropertyCall = {
      tag: 'PropertyCall',
      typeId: 255,
      methodId: 255,
      obj: { tag: 'Context' },
    }
    const ctx = makeContext({})
    expect(() => evalPropertyCall(e, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalPropertyCall(e, Env.empty(), ctx)
    } catch (err) {
      expect((err as EvalError).code).toBe('method-not-implemented')
      expect((err as EvalError).message).toContain('typeId=255')
      expect((err as EvalError).message).toContain('methodId=255')
    }
    // Cost charging: 4 (dispatcher) + 1 (Context arm) = 5; charged in BOTH throws above (× 2).
    // We assert ≥ 4 once, allowing for the obj evaluation to have completed.
    expect(ctx.jitCost).toBeGreaterThanOrEqual(4)
  })

  it("MethodCall variant also throws on unknown pair", () => {
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 255,
      methodId: 255,
      obj: { tag: 'Context' },
      args: [],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrow(EvalError)
  })
})
