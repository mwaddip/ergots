/**
 * v6 P4 — SGlobal.some (MethodCall, 106:9) and SGlobal.none (PropertyCall, 106:10)
 * eval handlers.
 *
 * JVM source: methods.scala:1986-1999 — both `FixedCost(JitCost(5))`, V3-gated
 * (`isV3OrLaterErgoTreeVersion`). `some(value: T): Option[T]` is a MethodCall
 * opcode (1 arg); `none[T](): Option[T]` is a PropertyCall opcode (0 args).
 *
 * Cost (DERIVED — consensus-load-bearing, asserted exactly):
 *   - `Global.some[Byte](Const 0)` (MethodCall):
 *       4 (dispatcher) + 5 (Global arm) + 5 (Const arg) + 5 (handler) = 19
 *   - `Global.none[Byte]()` (PropertyCall):
 *       4 (dispatcher) + 5 (Global arm) + 5 (handler) = 14
 *
 * Modeled on test/eval/sglobal-group-generator.test.ts (the 106:1 handler test).
 */

import { describe, expect, it } from 'vitest'
import { evalMethodCall, evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall as MethodCallExpr, PropertyCall as PropertyCallExpr, SType } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }

// Const 0 / Const 1 of type Byte — the `some` argument expr.
function constByte(value: number): MethodCallExpr['args'][number] {
  return { tag: 'Const', tpe: SBYTE, value: { kind: 'Byte', value } }
}

// Global.some[T](arg) — MethodCall opcode, 1 arg, explicitTypeArgs {T}.
function someExpr(arg: MethodCallExpr['args'][number]): MethodCallExpr {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 9,
    args: [arg],
    explicitTypeArgs: { T: SBYTE },
  }
}

// Global.none[T]() — PropertyCall opcode, 0 args, explicitTypeArgs {T}.
function noneExpr(): PropertyCallExpr {
  return {
    tag: 'PropertyCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 10,
    explicitTypeArgs: { T: SBYTE },
  }
}

describe('SGlobal.some (106:9) handler — v6 P4', () => {
  it('Global.some[Byte](Const 0) at treeVersion 3 → Some(Byte 0), cost 19', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(someExpr(constByte(0)), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBYTE, value: { kind: 'Byte', value: 0 } })
    expect(ctx.jitCost).toBe(19)
  })

  it('Global.some[Byte](Const 1) at treeVersion 3 → Some(Byte 1)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(someExpr(constByte(1)), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBYTE, value: { kind: 'Byte', value: 1 } })
    expect(ctx.jitCost).toBe(19)
  })
})

describe('SGlobal.none (106:10) handler — v6 P4', () => {
  it('Global.none[Byte]() at treeVersion 3 → None (elem Byte), cost 14', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalPropertyCall(noneExpr(), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBYTE, value: null })
    expect(ctx.jitCost).toBe(14)
  })
})

describe('SGlobal.some / none — V3 gate (minVersion 3)', () => {
  it('Global.some at treeVersion 2 throws EvalError(tree-version-too-low)', () => {
    const ctx = makeContext({ treeVersion: 2 })
    expect(() => evalMethodCall(someExpr(constByte(0)), Env.empty(), ctx)).toThrowError(EvalError)
    try {
      makeContext({ treeVersion: 2 })
      evalMethodCall(someExpr(constByte(0)), Env.empty(), makeContext({ treeVersion: 2 }))
    } catch (err) {
      expect((err as EvalError).code).toBe('tree-version-too-low')
    }
  })

  it('Global.none at treeVersion 2 throws EvalError(tree-version-too-low)', () => {
    const ctx = makeContext({ treeVersion: 2 })
    expect(() => evalPropertyCall(noneExpr(), Env.empty(), ctx)).toThrowError(EvalError)
    try {
      evalPropertyCall(noneExpr(), Env.empty(), makeContext({ treeVersion: 2 }))
    } catch (err) {
      expect((err as EvalError).code).toBe('tree-version-too-low')
    }
  })
})

describe('SGlobal.some / none — handler arity guards (V3)', () => {
  // `none` built as a MethodCall with 1 arg → handler's own 0-arg guard throws.
  it('none (106:10) as a MethodCall with 1 arg throws EvalError', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const badNone: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 10,
      args: [constByte(0)],
      explicitTypeArgs: { T: SBYTE },
    }
    expect(() => evalMethodCall(badNone, Env.empty(), ctx)).toThrowError(EvalError)
  })

  // `some` built as a PropertyCall (0 args) → handler's own 1-arg guard throws.
  it('some (106:9) as a PropertyCall (0 args) throws EvalError', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const badSome: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 9,
      explicitTypeArgs: { T: SBYTE },
    }
    expect(() => evalPropertyCall(badSome, Env.empty(), ctx)).toThrowError(EvalError)
  })
})
