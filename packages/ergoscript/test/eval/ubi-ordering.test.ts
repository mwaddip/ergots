import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { validateBinOpTypes } from '../../src/eval/validate-bin-op-types'
import type { SType, SValue, Expr, BinOp, RelationOp } from '../../src/mir/types'

const SUBI: SType = { tag: 'SUnsignedBigInt' }
const SINT: SType = { tag: 'SInt' }
const v3 = () => makeContext({ treeVersion: 3 })
const ubi = (v: bigint): SValue => ({ kind: 'UnsignedBigInt', value: v })
const constOf = (tpe: SType, value: SValue): Expr => ({ tag: 'Const', tpe, value } as unknown as Expr)
const rel = (op: RelationOp, left: Expr, right: Expr): BinOp =>
  ({ tag: 'BinOp', op: { kind: 'Relation', op }, left, right } as unknown as BinOp)
const R = (op: RelationOp, a: bigint, b: bigint): Expr =>
  rel(op, constOf(SUBI, ubi(a)), constOf(SUBI, ubi(b))) as unknown as Expr

function expectThrow(fn: () => unknown, code: string): void {
  let threw: EvalError | undefined
  try { fn() } catch (e) { threw = e as EvalError }
  expect(threw).toBeInstanceOf(EvalError)
  expect(threw?.code).toBe(code)
}

describe('UBI ordering BinOps (v6)', () => {
  it('Lt/Le/Gt/Ge: correct boolean, cost 30 (5+5 Const evals + 20 ordering)', () => {
    const cases: Array<[RelationOp, bigint, bigint, boolean]> = [
      ['Lt', 3n, 5n, true], ['Lt', 5n, 5n, false],
      ['Le', 5n, 5n, true], ['Gt', 9n, 2n, true], ['Ge', 2n, 9n, false],
    ]
    for (const [op, a, b, r] of cases) {
      const c = v3()
      expect(evalExpr(R(op, a, b), Env.empty(), c)).toEqual({ kind: 'Boolean', value: r })
      expect(c.jitCost).toBe(30) // 5 (left Const) + 20 (RELATION_ORDERING_COST) + 5 (right Const)
    }
  })

  it('mismatched operand (UBI < Int) → bin-op-kind-mismatch (eval branch)', () => {
    const e = rel('Lt', constOf(SUBI, ubi(2n)), constOf(SINT, { kind: 'Int', value: 3 })) as unknown as Expr
    expectThrow(() => evalExpr(e, Env.empty(), v3()), 'bin-op-kind-mismatch')
  })

  it('C1: validateBinOpTypes ACCEPTS a V3 LT(ubi, ubi) (the fork the review caught)', () => {
    const body = R('Lt', 3n, 5n)
    expect(() => validateBinOpTypes(body, 3)).not.toThrow()
  })

  it('C1: validateBinOpTypes REJECTS a V3 LT(Int, ubi) via SameType', () => {
    const body = rel('Lt', constOf(SINT, { kind: 'Int', value: 1 }), constOf(SUBI, ubi(2n))) as unknown as Expr
    expectThrow(() => validateBinOpTypes(body, 3), 'bin-op-kind-mismatch')
  })
})
