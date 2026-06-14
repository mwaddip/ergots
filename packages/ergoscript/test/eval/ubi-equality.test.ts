import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { SType, SValue, Expr, BinOp, RelationOp } from '../../src/mir/types'

const SUBI: SType = { tag: 'SUnsignedBigInt' }
const SBIGINT: SType = { tag: 'SBigInt' }
const v3 = () => makeContext({ treeVersion: 3 })
const ubi = (v: bigint): SValue => ({ kind: 'UnsignedBigInt', value: v })
const big = (v: bigint): SValue => ({ kind: 'BigInt', value: v })
const constOf = (tpe: SType, value: SValue): Expr => ({ tag: 'Const', tpe, value } as unknown as Expr)
const collOf = (elem: SType, items: SValue[]): SValue => ({ kind: 'Coll', elem, items })
const rel = (op: RelationOp, left: Expr, right: Expr): BinOp =>
  ({ tag: 'BinOp', op: { kind: 'Relation', op }, left, right } as unknown as BinOp)

describe('UBI equality BinOps (v6)', () => {
  it('EQ/NEQ scalar: correct boolean, cost 15 (5+5 Const evals + 5 EQ_BIGINT_COST)', () => {
    const c = v3()
    expect(evalExpr(rel('Eq', constOf(SUBI, ubi(5n)), constOf(SUBI, ubi(5n))) as unknown as Expr, Env.empty(), c))
      .toEqual({ kind: 'Boolean', value: true })
    expect(c.jitCost).toBe(15)
    expect(evalExpr(rel('Eq', constOf(SUBI, ubi(5n)), constOf(SUBI, ubi(6n))) as unknown as Expr, Env.empty(), v3()))
      .toEqual({ kind: 'Boolean', value: false })
    expect(evalExpr(rel('NEq', constOf(SUBI, ubi(5n)), constOf(SUBI, ubi(6n))) as unknown as Expr, Env.empty(), v3()))
      .toEqual({ kind: 'Boolean', value: true })
  })

  it('Coll[UBI] EQ: value + cost identical to the Coll[BigInt] analog', () => {
    const SCOLL_UBI: SType = { tag: 'SColl', elem: SUBI }
    const SCOLL_BIG: SType = { tag: 'SColl', elem: SBIGINT }
    const ubiEq = rel('Eq',
      constOf(SCOLL_UBI, collOf(SUBI, [ubi(1n), ubi(2n), ubi(3n)])),
      constOf(SCOLL_UBI, collOf(SUBI, [ubi(1n), ubi(2n), ubi(3n)]))) as unknown as Expr
    const bigEq = rel('Eq',
      constOf(SCOLL_BIG, collOf(SBIGINT, [big(1n), big(2n), big(3n)])),
      constOf(SCOLL_BIG, collOf(SBIGINT, [big(1n), big(2n), big(3n)]))) as unknown as Expr

    const cu = v3(); const ru = evalExpr(ubiEq, Env.empty(), cu)
    const cb = v3(); const rb = evalExpr(bigEq, Env.empty(), cb)
    expect(ru).toEqual({ kind: 'Boolean', value: true })
    expect(rb).toEqual({ kind: 'Boolean', value: true })
    expect(cu.jitCost).toBe(cb.jitCost) // UBI mirrors BigInt (EQ_COA_BigInt)

    expect(evalExpr(rel('Eq',
      constOf(SCOLL_UBI, collOf(SUBI, [ubi(1n), ubi(2n)])),
      constOf(SCOLL_UBI, collOf(SUBI, [ubi(1n)]))) as unknown as Expr, Env.empty(), v3()))
      .toEqual({ kind: 'Boolean', value: false })
    expect(evalExpr(rel('Eq',
      constOf(SCOLL_UBI, collOf(SUBI, [ubi(1n), ubi(9n)])),
      constOf(SCOLL_UBI, collOf(SUBI, [ubi(1n), ubi(2n)]))) as unknown as Expr, Env.empty(), v3()))
      .toEqual({ kind: 'Boolean', value: false })
  })
})
