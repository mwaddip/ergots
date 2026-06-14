/**
 * SGlobal.some (typeId 106, methodId 9) / SGlobal.none (106, methodId 10) —
 * v6 P4 Task 3.
 *
 * Verifies that `exprTpe` resolves the Option[T] return type for both methods
 * via the method-signature catalog + explicit type arg threading. Before this
 * task:
 *   - No signatures were registered for 106:9 / 106:10 → both returned SAny.
 *   - The PropertyCall arm of exprTpe passed `{}` as explicitTypeArgs,
 *     discarding any T bound on the node.
 *
 * JVM source: sigma/ast/methods.scala:1986-1999 (some/none in SGlobal).
 * Spec: docs/specs/2026-06-04-ergoscript-v6-p4-option-global-some-none-design.md
 */
import { describe, it, expect } from 'vitest'
import { exprTpe } from '../../src/mir/expr-tpe'
import type { Expr, SType } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }
const SBYTECOLL: SType = { tag: 'SColl', elem: { tag: 'SByte' } }

describe('Global.some / Global.none static return type (P0 via explicit type arg)', () => {
  it('some[Byte](Const) : Option[SByte]', () => {
    const node: Expr = {
      tag: 'MethodCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 9,
      args: [{ tag: 'Const', tpe: SBYTE, value: { kind: 'Byte', value: 0 } } as Expr],
      explicitTypeArgs: { T: SBYTE },
    }
    expect(exprTpe(node)).toEqual({ tag: 'SOption', elem: SBYTE })
  })

  it('none[Byte]() : Option[SByte]', () => {
    const node: Expr = {
      tag: 'PropertyCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 10,
      explicitTypeArgs: { T: SBYTE },
    }
    expect(exprTpe(node)).toEqual({ tag: 'SOption', elem: SBYTE })
  })

  it('none[Coll[Byte]]() : Option[Coll[SByte]] (substitution not hard-coded to SByte)', () => {
    const node: Expr = {
      tag: 'PropertyCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 10,
      explicitTypeArgs: { T: SBYTECOLL },
    }
    expect(exprTpe(node)).toEqual({ tag: 'SOption', elem: SBYTECOLL })
  })
})
