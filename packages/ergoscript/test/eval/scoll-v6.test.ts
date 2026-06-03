import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { methodSignature, resolveReturnTpe } from '../../src/mir/method-signatures'
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

const SLONG: SType = { tag: 'SLong' }
const SINT: SType = { tag: 'SInt' }
const v3 = () => makeContext({ treeVersion: 3 })

function collOf(items: SValue[], elem: SType): SValue { return { kind: 'Coll', elem, items } }
function longColl(...vals: number[]): SValue { return collOf(vals.map((v) => ({ kind: 'Long', value: BigInt(v) })), SLONG) }
function constExpr(value: SValue, tpe: SType): any { return { tag: 'Const', tpe, value } }
function call(obj: SValue, methodId: number, args: any[] = []): MethodCallExpr {
  return { tag: 'MethodCall', obj: constExpr(obj, { tag: 'SColl', elem: SLONG }), args, typeId: 12, methodId, explicitTypeArgs: {} }
}

describe('SColl.reverse (12:30)', () => {
  it('reverses, preserves elem type, cost = dispatcher 4 + Const 5 + handler 22', () => {
    const ctx = v3()
    expect(evalMethodCall(call(longColl(1, 2), 30), Env.empty(), ctx)).toEqual(longColl(2, 1))
    expect(ctx.jitCost).toBe(31) // 4 + 5 + (20 + 2×1 chunk)
  })
  it('empty → empty (n=0 still 1 chunk → handler 22)', () => {
    const ctx = v3()
    expect(evalMethodCall(call(longColl(), 30), Env.empty(), ctx)).toEqual(longColl())
    expect(ctx.jitCost).toBe(31)
  })
  it('rejects pre-V3 trees with tree-version-too-low', () => {
    let threw: EvalError | undefined
    try { evalMethodCall(call(longColl(1, 2), 30), Env.empty(), makeContext({ treeVersion: 2 })) } catch (e) { threw = e as EvalError }
    expect(threw).toBeInstanceOf(EvalError)
    expect(threw?.code).toBe('tree-version-too-low')
  })
  it('rejects non-Coll receiver with method-not-implemented', () => {
    const e: MethodCallExpr = { tag: 'MethodCall', obj: constExpr({ kind: 'Long', value: 5n }, SLONG), args: [], typeId: 12, methodId: 30, explicitTypeArgs: {} }
    let threw: EvalError | undefined
    try { evalMethodCall(e, Env.empty(), v3()) } catch (er) { threw = er as EvalError }
    expect(threw?.code).toBe('method-not-implemented')
  })
  it('static return type resolves to Coll[receiver-elem] (P0 generic)', () => {
    const sig = methodSignature(12, 30)!
    expect(resolveReturnTpe(sig, { tag: 'SColl', elem: SINT }, [], {})).toEqual({ tag: 'SColl', elem: SINT })
  })
})

function someOpt(v: SValue, elem: SType): SValue { return { kind: 'Option', elem, value: v } }
function noneOpt(elem: SType): SValue { return { kind: 'Option', elem, value: null } }
function intC(v: number): any { return constExpr({ kind: 'Int', value: v }, SINT) }

describe('SColl.get (12:33)', () => {
  it('in-range → Some(item), cost = 4 + 5(obj) + 5(idx) + 30(Fixed) = 44', () => {
    const ctx = v3()
    expect(evalMethodCall(call(longColl(1, 2), 33, [intC(0)]), Env.empty(), ctx))
      .toEqual(someOpt({ kind: 'Long', value: 1n }, SLONG))
    expect(ctx.jitCost).toBe(44)
  })
  it('index 1 → Some(2)', () => {
    expect(evalMethodCall(call(longColl(1, 2), 33, [intC(1)]), Env.empty(), v3()))
      .toEqual(someOpt({ kind: 'Long', value: 2n }, SLONG))
  })
  it('negative index → None (total, no throw)', () => {
    expect(evalMethodCall(call(longColl(1, 2), 33, [intC(-1)]), Env.empty(), v3())).toEqual(noneOpt(SLONG))
  })
  it('out-of-range index → None', () => {
    expect(evalMethodCall(call(longColl(1, 2), 33, [intC(2)]), Env.empty(), v3())).toEqual(noneOpt(SLONG))
  })
  it('empty coll → None', () => {
    expect(evalMethodCall(call(longColl(), 33, [intC(0)]), Env.empty(), v3())).toEqual(noneOpt(SLONG))
  })
  it('rejects non-Int index with method-not-implemented', () => {
    let threw: EvalError | undefined
    try { evalMethodCall(call(longColl(1, 2), 33, [constExpr(longColl(0), { tag: 'SColl', elem: SLONG })]), Env.empty(), v3()) } catch (e) { threw = e as EvalError }
    expect(threw?.code).toBe('method-not-implemented')
  })
  it('static return type resolves to Option[receiver-elem] (P0 generic)', () => {
    const sig = methodSignature(12, 33)!
    expect(resolveReturnTpe(sig, { tag: 'SColl', elem: SLONG }, [SINT], {})).toEqual({ tag: 'SOption', elem: SLONG })
  })
})

const bool = (v: boolean): SValue => ({ kind: 'Boolean', value: v })
function bigColl(...vals: number[]): SValue { return collOf(vals.map((v) => ({ kind: 'BigInt', value: BigInt(v) })), { tag: 'SBigInt' }) }
function call2(obj: SValue, methodId: number, arg: SValue): MethodCallExpr {
  return { tag: 'MethodCall', obj: constExpr(obj, { tag: 'SColl', elem: SLONG }), args: [constExpr(arg, { tag: 'SColl', elem: SLONG })], typeId: 12, methodId, explicitTypeArgs: {} }
}

describe('SColl.startsWith (12:31)', () => {
  it('true prefix; cost = 4 + 5 + 5 + handler 11 (Zip on receiver len=3) = 25', () => {
    const ctx = v3()
    expect(evalMethodCall(call2(longColl(1, 2, 3), 31, longColl(1, 2)), Env.empty(), ctx)).toEqual(bool(true))
    expect(ctx.jitCost).toBe(25)
  })
  it('full-equal prefix → true', () => {
    expect(evalMethodCall(call2(longColl(1, 2, 3), 31, longColl(1, 2, 3)), Env.empty(), v3())).toEqual(bool(true))
  })
  it('mismatched prefix → false', () => {
    expect(evalMethodCall(call2(longColl(1, 2, 3), 31, longColl(1, 2, 4)), Env.empty(), v3())).toEqual(bool(false))
  })
  it('longer prefix than receiver → false', () => {
    expect(evalMethodCall(call2(longColl(1, 2, 3), 31, longColl(1, 2, 3, 4)), Env.empty(), v3())).toEqual(bool(false))
  })
  it('empty prefix on empty → true; empty-receiver cost = 4 + 5 + 5 + 11 = 25', () => {
    const ctx = v3()
    expect(evalMethodCall(call2(longColl(), 31, longColl()), Env.empty(), ctx)).toEqual(bool(true))
    expect(ctx.jitCost).toBe(25)
  })
  it('COST-FREE comparison regression: matching multi-element startsWith charges ONLY the Zip envelope (no per-element EQ)', () => {
    // 3 matching Long elements: if sValueEquals leaked in, cost would be 25 + 3×EQ_PRIM(3) = 34.
    const ctx = v3()
    evalMethodCall(call2(longColl(1, 2, 3), 31, longColl(1, 2, 3)), Env.empty(), ctx)
    expect(ctx.jitCost).toBe(25)
  })
  it('COST-FREE regression with BigInt elements (louder: leaked cost would be +3×EQ_BIGINT)', () => {
    const ctx = v3()
    const e: MethodCallExpr = { tag: 'MethodCall', obj: constExpr(bigColl(1, 2, 3), { tag: 'SColl', elem: { tag: 'SBigInt' } }), args: [constExpr(bigColl(1, 2, 3), { tag: 'SColl', elem: { tag: 'SBigInt' } })], typeId: 12, methodId: 31, explicitTypeArgs: {} }
    evalMethodCall(e, Env.empty(), ctx)
    expect(ctx.jitCost).toBe(25) // NOT 25 + 3×EQ_BIGINT(5) = 40
  })
  it('rejects pre-V3 with tree-version-too-low', () => {
    let threw: EvalError | undefined
    try { evalMethodCall(call2(longColl(1), 31, longColl(1)), Env.empty(), makeContext({ treeVersion: 2 })) } catch (e) { threw = e as EvalError }
    expect(threw?.code).toBe('tree-version-too-low')
  })
  it('static return type is Boolean (closed)', () => {
    expect(resolveReturnTpe(methodSignature(12, 31)!, { tag: 'SColl', elem: SINT }, [{ tag: 'SColl', elem: SINT }], {})).toEqual({ tag: 'SBoolean' })
  })
})

describe('SColl.endsWith (12:32)', () => {
  it('true suffix; cost = 4 + 5 + 5 + 11 (Zip on receiver len=3) = 25', () => {
    const ctx = v3()
    expect(evalMethodCall(call2(longColl(1, 2, 3), 32, longColl(2, 3)), Env.empty(), ctx)).toEqual(bool(true))
    expect(ctx.jitCost).toBe(25)
  })
  it('non-suffix → false', () => {
    expect(evalMethodCall(call2(longColl(1, 2, 3), 32, longColl(1, 2)), Env.empty(), v3())).toEqual(bool(false))
  })
  it('full-equal → true', () => {
    expect(evalMethodCall(call2(longColl(1, 2, 3), 32, longColl(1, 2, 3)), Env.empty(), v3())).toEqual(bool(true))
  })
  it('longer suffix than receiver → false', () => {
    expect(evalMethodCall(call2(longColl(2, 3), 32, longColl(1, 2, 3)), Env.empty(), v3())).toEqual(bool(false))
  })
  it('empty suffix on empty → true', () => {
    expect(evalMethodCall(call2(longColl(), 32, longColl()), Env.empty(), v3())).toEqual(bool(true))
  })
  it('COST-FREE regression: matching suffix charges only the Zip envelope', () => {
    const ctx = v3()
    evalMethodCall(call2(longColl(1, 2, 3), 32, longColl(1, 2, 3)), Env.empty(), ctx)
    expect(ctx.jitCost).toBe(25)
  })
  it('rejects pre-V3 with tree-version-too-low', () => {
    let threw: EvalError | undefined
    try { evalMethodCall(call2(longColl(1), 32, longColl(1)), Env.empty(), makeContext({ treeVersion: 2 })) } catch (e) { threw = e as EvalError }
    expect(threw?.code).toBe('tree-version-too-low')
  })
})
