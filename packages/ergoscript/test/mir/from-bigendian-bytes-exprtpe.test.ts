import { describe, expect, it } from 'vitest'
import { exprTpe } from '../../src/mir/expr-tpe'
import type { MethodCall, SType } from '../../src/mir/types'

const COLL_BYTE: SType = { tag: 'SColl', elem: { tag: 'SByte' } }

/** Build a fromBigEndianBytes[T] MethodCall over a Coll[Byte] Const. */
function fbeb(T: SType): MethodCall {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 5,
    args: [{ tag: 'Const', tpe: COLL_BYTE, value: { kind: 'Coll', elem: { tag: 'SByte' }, items: [] } }],
    explicitTypeArgs: { T },
  }
}

describe('exprTpe — Global.fromBigEndianBytes (106:5)', () => {
  it('resolves the concrete return type from the explicit type arg', () => {
    expect(exprTpe(fbeb({ tag: 'SInt' }))).toEqual({ tag: 'SInt' })
    expect(exprTpe(fbeb({ tag: 'SLong' }))).toEqual({ tag: 'SLong' })
    expect(exprTpe(fbeb({ tag: 'SBigInt' }))).toEqual({ tag: 'SBigInt' })
    expect(exprTpe(fbeb({ tag: 'SUnsignedBigInt' }))).toEqual({ tag: 'SUnsignedBigInt' })
  })
})
