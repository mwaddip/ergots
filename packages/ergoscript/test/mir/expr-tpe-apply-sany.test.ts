/**
 * exprTpe(Apply) — SAny func relaxation (v6 P6 Task 5).
 *
 * An Apply whose func expression types to SAny (because the func itself is an
 * unresolved PropertyCall/MethodCall, which the A3 fallback returns SAny for)
 * must return SAny instead of throwing `apply-func-not-sfunc`. This mirrors
 * the ByIndex, OptionGet, SelectField, and Map arms which all carry the same
 * "SAny cascades through" convention: the JVM holds the concrete SFunc at
 * runtime but our static exprTpe can only say SAny; rejecting the tree would
 * be a false positive that over-rejects a JVM-accepted tree.
 *
 * SAny-cascade construct: PropertyCall with unregistered (typeId=999,
 * methodId=999) → exprTpe returns { tag: 'SAny' } (A3 fallback). This is
 * the same construct verified in the A3 coverage tests in expr-tpe.test.ts.
 *
 * Spec: docs/specs/2026-06-05-ergoscript-v6-p6-hof-lambdas-design.md (Task 5)
 */
import { describe, it, expect } from 'vitest'
import { exprTpe } from '../../src/mir/expr-tpe'
import type { Expr } from '../../src/mir/types'

// funcExpr: a PropertyCall with an unregistered (typeId, methodId) pair. The
// A3 exprTpe fallback returns { tag: 'SAny' } for any unregistered method —
// this is the canonical SAny-cascade source also used in expr-tpe.test.ts line
// 187-190 ("unregistered (typeId, methodId) falls back to SAny").
const funcExpr: Expr = {
  tag: 'PropertyCall',
  obj: {
    tag: 'Const',
    tpe: { tag: 'SGroupElement' },
    value: { kind: 'GroupElement', value: new Uint8Array(33) },
  },
  typeId: 999,
  methodId: 999,
  explicitTypeArgs: {},
}

const applyOfSAny: Expr = {
  tag: 'Apply',
  func: funcExpr,
  args: [{ tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } }],
}

describe('exprTpe(Apply) — SAny func relaxation', () => {
  it('sanity: the func expr itself types to SAny', () => {
    expect(exprTpe(funcExpr)).toEqual({ tag: 'SAny' })
  })
  it('Apply of an SAny-typed func returns SAny (no throw), mirroring ByIndex/OptionGet', () => {
    expect(exprTpe(applyOfSAny)).toEqual({ tag: 'SAny' })
  })
})
