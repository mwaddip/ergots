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
  // Arith/Relation/Logical are still skeletons that throw 'not-implemented-yet'.
  // Bit is now fully implemented (phase 2c Task 4) — its case is tested separately.
  const notYetCases: Array<{ name: string; expr: BinOp }> = [
    {
      name: 'Arith routes to evalArithOp',
      expr: { tag: 'BinOp', op: { kind: 'Arith', op: 'Plus' }, left: intConst(1), right: intConst(2) },
    },
    {
      name: 'Relation routes to evalRelationOp',
      expr: { tag: 'BinOp', op: { kind: 'Relation', op: 'Eq' }, left: intConst(1), right: intConst(1) },
    },
    {
      name: 'Logical routes to evalLogicalOp',
      expr: { tag: 'BinOp', op: { kind: 'Logical', op: 'And' }, left: boolConst(true), right: boolConst(false) },
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
        expect(message).toMatch(/Arith|Relation|Logical/)
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
})
