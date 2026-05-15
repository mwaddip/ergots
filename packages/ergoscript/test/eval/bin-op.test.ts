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
  const cases: Array<{ name: string; expr: BinOp }> = [
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
    {
      name: 'Bit routes to evalBitOp',
      expr: { tag: 'BinOp', op: { kind: 'Bit', op: 'BitAnd' }, left: intConst(0xff), right: intConst(0x0f) },
    },
  ]

  for (const { name, expr } of cases) {
    it(name, () => {
      const ctx = makeContext()
      // All four families currently throw 'not-implemented-yet' from skeletons.
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
        expect(message).toMatch(/Arith|Relation|Logical|Bit/)
      }
    })
  }
})
