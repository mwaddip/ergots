import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SType, SValue, Upcast, Downcast } from '../../src/mir/types'

const SUBI: SType = { tag: 'SUnsignedBigInt' }
const v3 = () => makeContext({ treeVersion: 3 })
const ubi = (v: bigint): SValue => ({ kind: 'UnsignedBigInt', value: v })
const constOf = (tpe: SType, value: SValue) => ({ tag: 'Const', tpe, value } as any)
const down = (input: any, tpe: SType): Downcast => ({ tag: 'Downcast', input, tpe })
const up = (input: any, tpe: SType): Upcast => ({ tag: 'Upcast', input, tpe } as Upcast)
function expectThrow(fn: () => unknown, code: string, ctx?: any, cost?: number) {
  let threw: EvalError | undefined
  try { fn() } catch (e) { threw = e as EvalError }
  expect(threw).toBeInstanceOf(EvalError); expect(threw?.code).toBe(code)
  if (ctx && cost !== undefined) expect(ctx.jitCost).toBe(cost)
}

describe('UBI cast matrix', () => {
  it('Downcast UBI -> Byte/Short/Int/Long: range-checked produce (cost 15)', () => {
    const c = v3()
    expect(evalExpr(down(constOf(SUBI, ubi(5n)), { tag: 'SByte' }), Env.empty(), c)).toEqual({ kind: 'Byte', value: 5 })
    expect(c.jitCost).toBe(15)
    expectThrow(() => evalExpr(down(constOf(SUBI, ubi(200n)), { tag: 'SByte' }), Env.empty(), v3()), 'downcast-overflow')
    expectThrow(() => evalExpr(down(constOf(SUBI, ubi(1n << 63n)), { tag: 'SLong' }), Env.empty(), v3()), 'downcast-overflow')
  })
  it('Downcast UBI -> BigInt: always unsupported (cost 35 charged then throw)', () => {
    const c = v3()
    expectThrow(() => evalExpr(down(constOf(SUBI, ubi(5n)), { tag: 'SBigInt' }), Env.empty(), c), 'unsigned-bigint-op-unsupported', c, 35)
  })
  it('Upcast UBI -> signed/BigInt: unsupported', () => {
    expectThrow(() => evalExpr(up(constOf(SUBI, ubi(5n)), { tag: 'SByte' }), Env.empty(), v3()), 'unsigned-bigint-op-unsupported')
    expectThrow(() => evalExpr(up(constOf(SUBI, ubi(5n)), { tag: 'SBigInt' }), Env.empty(), v3()), 'unsigned-bigint-op-unsupported')
  })
  it('Up/Downcast {Byte..Long} -> UBI: produce if >=0 (cost 35); negative -> out-of-range', () => {
    const c = v3()
    expect(evalExpr(down(constOf({ tag: 'SInt' }, { kind: 'Int', value: 5 }), SUBI), Env.empty(), c)).toEqual(ubi(5n))
    expect(c.jitCost).toBe(35)
    expect(evalExpr(up(constOf({ tag: 'SLong' }, { kind: 'Long', value: 9n }), SUBI), Env.empty(), v3())).toEqual(ubi(9n))
    expectThrow(() => evalExpr(down(constOf({ tag: 'SInt' }, { kind: 'Int', value: -1 }), SUBI), Env.empty(), v3()), 'unsigned-bigint-out-of-range')
  })
  it('Up/Downcast BigInt -> UBI: unsupported', () => {
    expectThrow(() => evalExpr(down(constOf({ tag: 'SBigInt' }, { kind: 'BigInt', value: 5n }), SUBI), Env.empty(), v3()), 'unsigned-bigint-op-unsupported')
    expectThrow(() => evalExpr(up(constOf({ tag: 'SBigInt' }, { kind: 'BigInt', value: 5n }), SUBI), Env.empty(), v3()), 'unsigned-bigint-op-unsupported')
  })
  it('Up/Downcast UBI -> UBI: identity (cost 35)', () => {
    const c = v3()
    expect(evalExpr(down(constOf(SUBI, ubi(42n)), SUBI), Env.empty(), c)).toEqual(ubi(42n))
    expect(c.jitCost).toBe(35)
    expect(evalExpr(up(constOf(SUBI, ubi(42n)), SUBI), Env.empty(), v3())).toEqual(ubi(42n))
  })
  it('signed-only casts still work (no UBI)', () => {
    expect(evalExpr(down(constOf({ tag: 'SInt' }, { kind: 'Int', value: 5 }), { tag: 'SByte' }), Env.empty(), v3())).toEqual({ kind: 'Byte', value: 5 })
    expectThrow(() => evalExpr(down(constOf({ tag: 'SLong' }, { kind: 'Long', value: 300n }), { tag: 'SByte' }), Env.empty(), v3()), 'downcast-overflow')
  })
  it('defensive (hand-built MIR): non-numeric source -> UBI target, and UBI source -> non-numeric target', () => {
    // castToUBI default arm: Boolean source, UBI target
    expectThrow(() => evalExpr(down(constOf({ tag: 'SBoolean' }, { kind: 'Boolean', value: true }), SUBI), Env.empty(), v3()), 'bin-op-not-numeric')
    // downcastUBI undefined-kind arm: UBI source, non-numeric (Boolean) target
    expectThrow(() => evalExpr(down(constOf(SUBI, ubi(5n)), { tag: 'SBoolean' }), Env.empty(), v3()), 'bin-op-not-numeric')
  })
})
