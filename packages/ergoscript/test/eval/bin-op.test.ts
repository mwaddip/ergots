import { describe, it, expect } from 'vitest'

import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { BinOp, Expr } from '../../src/mir/types'

const intConst = (v: number): Expr =>
  ({ tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: v } })
const boolConst = (b: boolean): Expr =>
  ({ tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: b } })

describe('BinOp central dispatch — routes to per-family sub-arms', () => {
  // All four BinOp families are now fully implemented (phase 2c Tasks 4-8):
  //   Bit (Task 4), Logical (Task 5), Relation (Tasks 6+7), Arith (Task 8).

  // Arith is implemented (Task 8): assert routing AND correct computed value.
  // Plus(1, 2) = 3 (Int); cost = Plus_non-bigint(15) + left_Const(5) + right_Const(5) = 25.
  it('Arith routes to evalArithOp and computes correctly (task 8)', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Arith', op: 'Plus' },
      left: intConst(1),
      right: intConst(2),
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 3 })
    // Cost = Plus non-bigint (15) + left_Const (5) + right_Const (5) = 25.
    // sigma-rust bin_op.rs:196: add_jit_cost(15) for Plus when !is_bigint.
    expect(ctx.jitCost).toBe(25)
  })

  // Bit is implemented: assert routing AND correct computed value.
  // 0xff & 0x0f = 0x0f = 15 (Int).
  it('Bit routes to evalBitOp and computes correctly', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Bit', op: 'BitAnd' },
      left: intConst(0xff),
      right: intConst(0x0f),
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 0x0f })
    // Cost = BIT_OP_COST(1) + left_Const(5) + right_Const(5) = 11
    expect(ctx.jitCost).toBe(11)
  })

  // Logical is implemented: assert routing AND correct computed value.
  // And(true, false) = false.
  it('Logical routes to evalLogicalOp and computes correctly', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Logical', op: 'And' },
      left: boolConst(true),
      right: boolConst(false),
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Boolean', value: false })
    // Cost = LOGICAL_OP_COST(20) + left_Const(5) + right_Const(5) = 30
    expect(ctx.jitCost).toBe(30)
  })

  // Relation (ordering) is implemented (task 6): assert routing AND correct value.
  // Lt(1, 2) = true.
  it('Relation routes to evalRelationOp and computes correctly (ordering)', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Relation', op: 'Lt' },
      left: intConst(1),
      right: intConst(2),
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Boolean', value: true })
    // Cost = RELATION_ORDERING_COST(20) + left_Const(5) + right_Const(5) = 30
    expect(ctx.jitCost).toBe(30)
  })

  // Eq/NEq are implemented in task 7 — assert routing AND correct computed value.
  // Eq(1, 1) = true; cost = left_Const(5) + right_Const(5) + EQ_PRIM_COST(3) = 13.
  it('Relation Eq routes to evalRelationOp and computes correctly (task 7)', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Relation', op: 'Eq' },
      left: intConst(1),
      right: intConst(1),
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Boolean', value: true })
    // Cost = left_Const(5) + right_Const(5) + EQ_PRIM_COST(3) = 13.
    // No envelope cost for Eq (bin_op.rs:205 match arm is empty).
    expect(ctx.jitCost).toBe(13)
  })

  // NEq(1, 2) = true.
  it('Relation NEq routes to evalRelationOp and computes correctly (task 7)', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Relation', op: 'NEq' },
      left: intConst(1),
      right: intConst(2),
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(13)
  })
})
