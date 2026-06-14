import { describe, it, expect } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { exprTpe } from '../../src/mir/expr-tpe'
import type { MethodCall as MC, SType, SValue, Expr } from '../../src/mir/types'

const SUBI: SType = { tag: 'SUnsignedBigInt' }
const SBIGINT: SType = { tag: 'SBigInt' }
const v3 = () => makeContext({ treeVersion: 3 })
const big = (v: bigint): SValue => ({ kind: 'BigInt', value: v })
const ubi = (v: bigint): SValue => ({ kind: 'UnsignedBigInt', value: v })
const constOf = (tpe: SType, value: SValue): Expr => ({ tag: 'Const', tpe, value } as unknown as Expr)
const toUnsigned = (v: bigint): MC =>
  ({ tag: 'MethodCall', obj: constOf(SBIGINT, big(v)), args: [], typeId: 6, methodId: 14, explicitTypeArgs: {} } as unknown as MC)
const toSigned = (v: bigint): MC =>
  ({ tag: 'MethodCall', obj: constOf(SUBI, ubi(v)), args: [], typeId: 9, methodId: 19, explicitTypeArgs: {} } as unknown as MC)

function expectThrow(fn: () => unknown, code: string): void {
  let threw: EvalError | undefined
  try { fn() } catch (e) { threw = e as EvalError }
  expect(threw).toBeInstanceOf(EvalError)
  expect(threw?.code).toBe(code)
}

describe('UBI bridge methods (v6)', () => {
  it('BigInt.toUnsigned: non-negative produces UBI, cost 14 (4 dispatcher + 5 obj Const + 5 handler)', () => {
    const c = v3()
    expect(evalMethodCall(toUnsigned(5n), Env.empty(), c)).toEqual(ubi(5n))
    expect(c.jitCost).toBe(14)
  })
  it('BigInt.toUnsigned: negative → unsigned-bigint-out-of-range', () => {
    expectThrow(() => evalMethodCall(toUnsigned(-1n), Env.empty(), v3()), 'unsigned-bigint-out-of-range')
  })
  it('UBI.toSigned: in-range produces BigInt, cost 19 (4 dispatcher + 5 obj Const + 10 handler)', () => {
    const c = v3()
    expect(evalMethodCall(toSigned(5n), Env.empty(), c)).toEqual(big(5n))
    expect(c.jitCost).toBe(19)
  })
  it('UBI.toSigned: >= 2^255 → bigint-result-out-of-range', () => {
    expectThrow(() => evalMethodCall(toSigned(1n << 255n), Env.empty(), v3()), 'bigint-result-out-of-range')
  })
  it('v5 tree (treeVersion 2): tree-version-too-low', () => {
    expectThrow(() => evalMethodCall(toUnsigned(5n), Env.empty(), makeContext({ treeVersion: 2 })), 'tree-version-too-low')
    expectThrow(() => evalMethodCall(toSigned(5n), Env.empty(), makeContext({ treeVersion: 2 })), 'tree-version-too-low')
  })
  it('wrong-kind receiver → numeric-method-bad-operand (both bridges)', () => {
    const badU = ({ tag: 'MethodCall', obj: constOf({ tag: 'SInt' }, { kind: 'Int', value: 1 }), args: [], typeId: 6, methodId: 14, explicitTypeArgs: {} } as unknown as MC)
    expectThrow(() => evalMethodCall(badU, Env.empty(), v3()), 'numeric-method-bad-operand')
    const badS = ({ tag: 'MethodCall', obj: constOf({ tag: 'SInt' }, { kind: 'Int', value: 1 }), args: [], typeId: 9, methodId: 19, explicitTypeArgs: {} } as unknown as MC)
    expectThrow(() => evalMethodCall(badS, Env.empty(), v3()), 'numeric-method-bad-operand')
  })
  it('exprTpe: bigint.toUnsigned → SUnsignedBigInt; ubi.toSigned → SBigInt', () => {
    expect(exprTpe(toUnsigned(5n) as unknown as Expr)).toEqual(SUBI)
    expect(exprTpe(toSigned(5n) as unknown as Expr)).toEqual(SBIGINT)
  })
})
