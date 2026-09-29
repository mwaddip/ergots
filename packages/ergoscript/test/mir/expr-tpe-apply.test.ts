// JVM Apply.tpe (sigma/ast/values.scala:1247-1251): SFunc → range, SCollectionType →
// elemType, anything else → NoType. STuple is not an SCollectionType (SType.scala:838).
import { describe, it, expect } from 'vitest'
import { exprTpe, ExprTpeError } from '../../src/mir/expr-tpe'
import type { Expr } from '../../src/mir/types'

const int0: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } }

describe('exprTpe(Apply) — the JVM Apply.tpe', () => {
  it('a collection function gives its element type', () => {
    const func: Expr = { tag: 'Const', tpe: { tag: 'SColl', elem: { tag: 'SSigmaProp' } },
      value: { kind: 'Coll', elem: { tag: 'SSigmaProp' }, items: [] } } as Expr
    expect(exprTpe({ tag: 'Apply', func, args: [int0] } as Expr)).toEqual({ tag: 'SSigmaProp' })
  })

  it('a non-function, non-collection function throws apply-func-no-type (JVM NoType)', () => {
    let err: unknown
    try { exprTpe({ tag: 'Apply', func: int0, args: [int0] } as Expr) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ExprTpeError)
    expect((err as ExprTpeError).code).toBe('apply-func-no-type')
  })

  it('a tuple function is NoType too (STuple is not an SCollectionType)', () => {
    const func: Expr = { tag: 'Const', tpe: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }] },
      value: { kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }] } } as Expr
    let err: unknown
    try { exprTpe({ tag: 'Apply', func, args: [int0] } as Expr) } catch (e) { err = e }
    expect((err as ExprTpeError).code).toBe('apply-func-no-type')
  })
})
