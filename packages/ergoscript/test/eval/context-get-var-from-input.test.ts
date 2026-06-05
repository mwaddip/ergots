/**
 * v6 P7a — SContext.getVarFromInput (MethodCall, 101:12) eval handler +
 * the inputExtensions context field.
 *
 * JVM source: methods.scala:1755-1765 — GetVar.costKind =
 * FixedCost(JitCost(10)) (transformers.scala:585-590), v6Methods-only
 * (:1773-1775). Eval = CContext.getVarFromInput (CContext.scala:76-83):
 * TOTAL, never throws — OOB input index, missing var, AND type-mismatch all
 * → None. Deliberate JVM asymmetry vs self-getVar ('get-var-type-mismatch'
 * THROW) and Box.getReg ('register-type-mismatch' THROW) — pinned below.
 *
 * Blessed shape (LanguageSpecificationV6.scala:1889-1919, 4 verifyCases):
 * missing input → None · Some(true) · wrong-typed var → None · Some(false).
 *
 * Cost (DERIVED — consensus-load-bearing, asserted exactly):
 *   Context.getVarFromInput[T](Const Short, Const Byte):
 *   4 (dispatcher) + 1 (Context arm) + 5 + 5 (Const args) + 10 (handler) = 25
 *
 * Modeled on test/eval/global-some-none.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { evalGetVar } from '../../src/eval/get-var'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { ContextExtension, MethodCall as MethodCallExpr, SType } from '../../src/mir/types'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SINT: SType = { tag: 'SInt' }

function gvfiExpr(inputIdx: number, varId: number, t: SType): MethodCallExpr {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Context' },
    typeId: 101,
    methodId: 12,
    args: [
      { tag: 'Const', tpe: { tag: 'SShort' }, value: { kind: 'Short', value: inputIdx } },
      { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: varId } },
    ],
    explicitTypeArgs: { T: t },
  }
}

// Input 0 carries var 11: Boolean true; input 1 carries var 11: Boolean false
// and var 12: Int 5 (the wrong-type probe target).
const ext0: ContextExtension = {
  values: { 11: { tpe: SBOOLEAN, value: { kind: 'Boolean', value: true } } },
}
const ext1: ContextExtension = {
  values: {
    11: { tpe: SBOOLEAN, value: { kind: 'Boolean', value: false } },
    12: { tpe: SINT, value: { kind: 'Int', value: 5 } },
  },
}

describe('SContext.getVarFromInput (101:12) handler — v6 P7a', () => {
  it('input 0 var 11 → Some(true) (blessed-shape), cost 25', () => {
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0, ext1] })
    const result = evalMethodCall(gvfiExpr(0, 11, SBOOLEAN), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBOOLEAN, value: { kind: 'Boolean', value: true } })
    expect(ctx.jitCost).toBe(25)
  })

  it('input 1 var 11 → Some(false) (blessed-shape)', () => {
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0, ext1] })
    const result = evalMethodCall(gvfiExpr(1, 11, SBOOLEAN), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBOOLEAN, value: { kind: 'Boolean', value: false } })
  })

  it('input index beyond the array → None (blessed-shape: missing input)', () => {
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0] })
    const result = evalMethodCall(gvfiExpr(3, 11, SBOOLEAN), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBOOLEAN, value: null })
  })

  it('wrong-typed var → None, NOT a throw (blessed-shape; the asymmetry)', () => {
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0, ext1] })
    // var 12 at input 1 holds an Int; requesting Boolean → None.
    const result = evalMethodCall(gvfiExpr(1, 12, SBOOLEAN), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBOOLEAN, value: null })
  })

  it('negative input index → None', () => {
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0] })
    const result = evalMethodCall(gvfiExpr(-1, 11, SBOOLEAN), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBOOLEAN, value: null })
  })

  it('missing var id → None', () => {
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0] })
    const result = evalMethodCall(gvfiExpr(0, 99, SBOOLEAN), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBOOLEAN, value: null })
  })

  it('absent inputExtensions field → None (the dataInputs absent-=-empty convention)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(gvfiExpr(0, 11, SBOOLEAN), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SBOOLEAN, value: null })
  })

  it('rejects at treeVersion 2 with tree-version-too-low', () => {
    const ctx = makeContext({ treeVersion: 2, inputExtensions: [ext0] })
    expect(() => evalMethodCall(gvfiExpr(0, 11, SBOOLEAN), Env.empty(), ctx))
      .toThrowError(expect.objectContaining({ code: 'tree-version-too-low' }))
  })

  it('rejects a non-Short first arg', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 12,
      args: [
        { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: 0 } },
        { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 11 } },
      ],
      explicitTypeArgs: { T: SBOOLEAN },
    }
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0] })
    expect(() => evalMethodCall(expr, Env.empty(), ctx)).toThrowError(/expects a Short input index/)
  })

  it('rejects extra args (arity 2 exact — JVM reflection-arity parity)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 12,
      args: [
        { tag: 'Const', tpe: { tag: 'SShort' }, value: { kind: 'Short', value: 0 } },
        { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 11 } },
        { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 12 } },
      ],
      explicitTypeArgs: { T: SBOOLEAN },
    }
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0] })
    expect(() => evalMethodCall(expr, Env.empty(), ctx)).toThrowError(/expects a Short input index/)
  })

  it('zero args (crafted PropertyCall shape) → eval-throws via the arity guard', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 12,
      args: [],
      explicitTypeArgs: { T: SBOOLEAN },
    }
    const ctx = makeContext({ treeVersion: 3, inputExtensions: [ext0] })
    expect(() => evalMethodCall(expr, Env.empty(), ctx)).toThrowError(/expects a Short input index/)
  })
})

describe('three-way type-mismatch asymmetry (spec §3.3) — side-by-side pin', () => {
  it('self getVar on a wrong-typed var THROWS get-var-type-mismatch; getVarFromInput on the same data returns None', () => {
    // Same logical var: id 12 holds Int 5; both read it as Boolean.
    const ctx = makeContext({ treeVersion: 3, extension: ext1, inputExtensions: [ext1] })
    expect(() => evalGetVar({ tag: 'GetVar', varId: 12, varTpe: SBOOLEAN }, Env.empty(), ctx))
      .toThrowError(expect.objectContaining({ code: 'get-var-type-mismatch' }))
    const viaInput = evalMethodCall(gvfiExpr(0, 12, SBOOLEAN), Env.empty(), ctx)
    expect(viaInput).toEqual({ kind: 'Option', elem: SBOOLEAN, value: null })
    // (Box.getReg's THROW side of the asymmetry is pinned in box-get-reg.test.ts.)
  })
})
