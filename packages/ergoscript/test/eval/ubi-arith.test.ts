import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SType, SValue, Expr, BinOp, ArithOp } from '../../src/mir/types'

const SUBI: SType = { tag: 'SUnsignedBigInt' }
const SINT: SType = { tag: 'SInt' }
const UBI_MAX = (1n << 256n) - 1n
const v3 = () => makeContext({ treeVersion: 3 })
const ubi = (v: bigint): SValue => ({ kind: 'UnsignedBigInt', value: v })
const constOf = (tpe: SType, value: SValue): Expr => ({ tag: 'Const', tpe, value } as unknown as Expr)
const arith = (op: ArithOp, left: Expr, right: Expr): BinOp =>
  ({ tag: 'BinOp', op: { kind: 'Arith', op }, left, right } as unknown as BinOp)
const A = (op: ArithOp, a: bigint, b: bigint): Expr =>
  arith(op, constOf(SUBI, ubi(a)), constOf(SUBI, ubi(b))) as unknown as Expr

function expectThrow(fn: () => unknown, code: string): void {
  let threw: EvalError | undefined
  try { fn() } catch (e) { threw = e as EvalError }
  expect(threw).toBeInstanceOf(EvalError)
  expect(threw?.code).toBe(code)
}

describe('UBI arithmetic BinOps (v6)', () => {
  // Cost notes: each Const operand charges 5; arithCost(Plus/Minus/Multiply, false)=15,
  // arithCost(Divide/Modulo, false)=15, arithCost(Min/Max, false)=5.
  // Total with two Const operands: Plus/Minus/Multiply/Divide/Modulo = 5+15+5=25; Min/Max = 5+5+5=15.
  it('Plus/Minus/Multiply: in-range, cost 25 (5+15+5)', () => {
    for (const [op, a, b, r] of [['Plus', 2n, 3n, 5n], ['Minus', 9n, 4n, 5n], ['Multiply', 6n, 7n, 42n]] as const) {
      const c = v3()
      expect(evalExpr(A(op, a, b), Env.empty(), c)).toEqual(ubi(r))
      expect(c.jitCost).toBe(25)
    }
  })

  it('Divide/Modulo: truncating quotient + non-negative remainder, cost 25 (5+15+5)', () => {
    const c = v3()
    expect(evalExpr(A('Divide', 17n, 5n), Env.empty(), c)).toEqual(ubi(3n))
    expect(c.jitCost).toBe(25)
    const cm = v3()
    expect(evalExpr(A('Modulo', 17n, 5n), Env.empty(), cm)).toEqual(ubi(2n))
    expect(cm.jitCost).toBe(25)
  })

  it('Min/Max: cost 15 (5+5+5)', () => {
    const c = v3()
    expect(evalExpr(A('Min', 8n, 3n), Env.empty(), c)).toEqual(ubi(3n))
    expect(c.jitCost).toBe(15)
    expect(evalExpr(A('Max', 8n, 3n), Env.empty(), v3())).toEqual(ubi(8n))
  })

  it('Plus/Multiply overflow → unsigned-bigint-out-of-range', () => {
    expectThrow(() => evalExpr(A('Plus', UBI_MAX, 1n), Env.empty(), v3()), 'unsigned-bigint-out-of-range')
    expectThrow(() => evalExpr(A('Multiply', 1n << 128n, 1n << 128n), Env.empty(), v3()), 'unsigned-bigint-out-of-range')
  })

  it('Minus underflow → unsigned-bigint-out-of-range', () => {
    expectThrow(() => evalExpr(A('Minus', 0n, 1n), Env.empty(), v3()), 'unsigned-bigint-out-of-range')
  })

  it('Divide/Modulo by zero → arith-divide-by-zero', () => {
    expectThrow(() => evalExpr(A('Divide', 5n, 0n), Env.empty(), v3()), 'arith-divide-by-zero')
    expectThrow(() => evalExpr(A('Modulo', 5n, 0n), Env.empty(), v3()), 'arith-divide-by-zero')
  })

  it('mismatched operand (UBI + Int) → bin-op-kind-mismatch', () => {
    const e = arith('Plus', constOf(SUBI, ubi(2n)), constOf(SINT, { kind: 'Int', value: 3 })) as unknown as Expr
    expectThrow(() => evalExpr(e, Env.empty(), v3()), 'bin-op-kind-mismatch')
  })
})
