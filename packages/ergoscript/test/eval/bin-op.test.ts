import { describe, it, expect } from 'vitest'

import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { BinOp, Expr } from '../../src/mir/types'

const intConst = (v: number): Expr =>
  ({ tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: v } })
const boolConst = (b: boolean): Expr =>
  ({ tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: b } })

describe('BinOp central dispatch — routes to per-family sub-arms', () => {
  // Arith is still a skeleton that throws 'not-implemented-yet'.
  // Bit, Logical, and Relation (ordering subset) are now fully implemented
  // (phase 2c Tasks 4, 5, and 6). Eq/NEq still throw 'not-implemented-yet'.
  const notYetCases: Array<{ name: string; expr: BinOp }> = [
    {
      name: 'Arith routes to evalArithOp',
      expr: { tag: 'BinOp', op: { kind: 'Arith', op: 'Plus' }, left: intConst(1), right: intConst(2) },
    },
  ]

  for (const { name, expr } of notYetCases) {
    it(name, () => {
      const ctx = makeContext()
      // These families still throw 'not-implemented-yet' from skeletons.
      // The test asserts the routing happens — i.e., evalBinOp dispatches, no
      // raw "variant 'BinOp' not implemented" from the central evalExpr default.
      expect(() => evalExpr(expr, Env.empty(), ctx)).toThrow(EvalError)
      try {
        evalExpr(expr, Env.empty(), ctx)
      } catch (e) {
        const code = (e as EvalError).code
        const message = (e as EvalError).message
        expect(code).toBe('not-implemented-yet')
        // Message must come from the family skeleton, not from the central
        // dispatch's default. Each family says its own name.
        expect(message).toMatch(/Arith/)
      }
    })
  }

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

  // Eq/NEq still throw 'not-implemented-yet' — task 7 lands them.
  it('Relation Eq still throws not-implemented-yet (task 7 deferred)', () => {
    const expr: BinOp = {
      tag: 'BinOp',
      op: { kind: 'Relation', op: 'Eq' },
      left: intConst(1),
      right: intConst(1),
    }
    const ctx = makeContext()
    expect(() => evalExpr(expr, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalExpr(expr, Env.empty(), ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('not-implemented-yet')
      expect((e as EvalError).message).toMatch(/Eq/)
    }
  })
})
