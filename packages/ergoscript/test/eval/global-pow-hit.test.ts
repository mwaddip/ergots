import { describe, expect, it } from 'vitest'
import { evalGlobalPowHit } from '../../src/eval/global-pow-hit'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SType, SValue, MethodCall } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }
const FAIL = 'pow-hit-invalid-params'

function collByte(bytes: number[]): SValue {
  return { kind: 'Coll', elem: SBYTE, items: bytes.map((b) => ({ kind: 'Byte', value: (b << 24) >> 24 })) }
}
function intVal(n: number): SValue { return { kind: 'Int', value: n } }

// Blessed h=614,440 vector (from sigma-rust / facts/ergoscript-eval.md)
// MSG: 7 bytes (L_msg=7), NONCE: 8 bytes (L_nonce=8), H: 4 bytes (L_h=4)
// L = 7+8+4 = 19; k=32; c = 500 + (32+1) * (trunc(19/128)+1) * 7 = 500 + 33*1*7 = 731
const MSG = [0x0a, 0x10, 0x1b, 0x8c, 0x6a, 0x4f, 0x2e]
const NONCE = [0, 0, 0, 0, 0, 0, 0, 0x2c]
const H = [0, 0, 0, 0]
const N = 1024 * 1024
const EXPECTED = 326674862673836209462483453386286740270338859283019276168539876024851191344n

function powHit(k: number, n: number, ctx = makeContext({ treeVersion: 3 })): SValue {
  return evalGlobalPowHit({ kind: 'Global' }, [intVal(k), collByte(MSG), collByte(NONCE), collByte(H), intVal(n)], ctx)
}

describe('Global.powHit (106:8)', () => {
  it('blessed k=32 vector -> UnsignedBigInt hit', () => {
    expect(powHit(32, N)).toEqual({ kind: 'UnsignedBigInt', value: EXPECTED })
  })
  it('charges FixedCost 731 for the blessed vector (k=32, L=19)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    powHit(32, N, ctx)
    expect(ctx.jitCost).toBe(731)
  })
  it('chunk-boundary cost: L=128 -> 2 chunks (locks bespoke floor(L/128)+1, not the (n-1)/cs+1 helper)', () => {
    // msg 116 + nonce 8 + h 4 = 128 = exactly one chunkSize.
    // bespoke: trunc(128/128)+1 = 2 -> 500 + (32+1)*2*7 = 962.
    // the PerItemCost (n-1)/cs+1 helper would give 1 chunk -> 731 (a consensus fork).
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalGlobalPowHit(
      { kind: 'Global' },
      [intVal(32), collByte(new Array(116).fill(1)), collByte(NONCE), collByte(H), intVal(N)],
      ctx,
    )
    expect(r.kind).toBe('UnsignedBigInt')
    expect(ctx.jitCost).toBe(962)
  })
  it('require(k<=32): rejects, charging cost first (k=33 -> 738)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    try { powHit(33, N, ctx); throw new Error('expected EvalError') }
    catch (e) { expect((e as EvalError).code).toBe(FAIL) }
    expect(ctx.jitCost).toBe(738)
  })
  it('require(k>=2): rejects k=1', () => {
    try { powHit(1, N); throw new Error('expected EvalError') }
    catch (e) { expect((e as EvalError).code).toBe(FAIL) }
  })
  it('require(N>=16): rejects N=15', () => {
    try { powHit(32, 15); throw new Error('expected EvalError') }
    catch (e) { expect((e as EvalError).code).toBe(FAIL) }
  })
  it('rejects a non-Int k at eval', () => {
    const ctx = makeContext({ treeVersion: 3 })
    try {
      evalGlobalPowHit({ kind: 'Global' }, [collByte([1]), collByte(MSG), collByte(NONCE), collByte(H), intVal(N)], ctx)
      throw new Error('expected EvalError')
    } catch (e) { expect((e as EvalError).code).toBe(FAIL) }
  })
  it('dispatcher rejects 106:8 for a pre-V3 tree', () => {
    const mc: MethodCall = {
      tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 8,
      args: [
        { tag: 'Const', tpe: { tag: 'SInt' }, value: intVal(32) },
        { tag: 'Const', tpe: { tag: 'SColl', elem: SBYTE }, value: collByte(MSG) },
        { tag: 'Const', tpe: { tag: 'SColl', elem: SBYTE }, value: collByte(NONCE) },
        { tag: 'Const', tpe: { tag: 'SColl', elem: SBYTE }, value: collByte(H) },
        { tag: 'Const', tpe: { tag: 'SInt' }, value: intVal(N) },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({ treeVersion: 2 })
    try { evalMethodCall(mc, Env.empty(), ctx); throw new Error('expected EvalError') }
    catch (e) { expect((e as EvalError).code).toBe('tree-version-too-low') }
  })
  it('round-trips a real V3 powHit call through evalMethodCall', () => {
    const mc: MethodCall = {
      tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 8,
      args: [
        { tag: 'Const', tpe: { tag: 'SInt' }, value: intVal(32) },
        { tag: 'Const', tpe: { tag: 'SColl', elem: SBYTE }, value: collByte(MSG) },
        { tag: 'Const', tpe: { tag: 'SColl', elem: SBYTE }, value: collByte(NONCE) },
        { tag: 'Const', tpe: { tag: 'SColl', elem: SBYTE }, value: collByte(H) },
        { tag: 'Const', tpe: { tag: 'SInt' }, value: intVal(N) },
      ],
      explicitTypeArgs: {},
    }
    expect(evalMethodCall(mc, Env.empty(), makeContext({ treeVersion: 3 }))).toEqual({ kind: 'UnsignedBigInt', value: EXPECTED })
  })
})
