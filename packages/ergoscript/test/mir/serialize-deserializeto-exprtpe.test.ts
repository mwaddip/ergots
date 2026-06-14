/**
 * SGlobal.serialize (typeId 106, methodId 3) / SGlobal.deserializeTo (106, methodId 4) —
 * v6 P5a Task 1.
 *
 * Verifies that `exprTpe` resolves the return types for both methods via the
 * method-signature catalog. Before this task:
 *   - No signatures were registered for 106:3 / 106:4 → both returned SAny.
 *
 * serialize (106:3): closed return type → Coll[Byte] (T is the input-value type;
 *   output is always Coll[Byte] regardless of T — closed tRange).
 * deserializeTo[T] (106:4): generic return type → T resolved from explicitTypeArgs.
 *
 * JVM source: sigma/ast/methods.scala:1957 (serialize), :1906 (deserializeTo)
 * Spec: docs/specs/2026-06-04-ergoscript-v6-p5a-serialize-deserializeto-design.md
 */
import { describe, expect, it } from 'vitest'
import { exprTpe } from '../../src/mir/expr-tpe'
import type { MethodCall, SType } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }
const COLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }

describe('serialize / deserializeTo — exprTpe (P0 resolver)', () => {
  it('serialize (106:3) → Coll[Byte] (closed tRange)', () => {
    const mc: MethodCall = {
      tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 3,
      args: [{ tag: 'Const', tpe: SBYTE, value: { kind: 'Byte', value: 0 } }],
      explicitTypeArgs: {},
    }
    expect(exprTpe(mc)).toEqual(COLL_BYTE)
  })

  it('deserializeTo[Int] (106:4) → Int (T from explicit type arg)', () => {
    const mc: MethodCall = {
      tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 4,
      args: [{ tag: 'Const', tpe: COLL_BYTE, value: { kind: 'Coll', elem: SBYTE, items: [] } }],
      explicitTypeArgs: { T: { tag: 'SInt' } },
    }
    expect(exprTpe(mc)).toEqual({ tag: 'SInt' })
  })
})
