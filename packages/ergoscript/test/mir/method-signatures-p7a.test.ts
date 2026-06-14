/**
 * v6 P7a — method-signature entries for Box.getReg (99:19),
 * Context.getVarFromInput (101:12), GroupElement.expUnsigned (7:6).
 *
 * JVM sources: methods.scala:1338-1347 (getRegMethodV6, SFunc([SBox,SInt],
 * SOption(tT), [T])), :1755-1765 (getVarFromInputMethod, SFunc([SContext,
 * SShort,SByte], SOption(tT), [T])), :656-660 (ExponentiateUnsignedMethod,
 * SFunc([SGroupElement,SUnsignedBigInt], SGroupElement) — closed tRange).
 */

import { describe, expect, it } from 'vitest'
import { methodSignature, resolveReturnTpe } from '../../src/mir/method-signatures'
import type { SType } from '../../src/mir/types'

const SLONG: SType = { tag: 'SLong' }
const SBOOLEAN: SType = { tag: 'SBoolean' }

describe('v6 P7a method signatures', () => {
  it('Box.getReg (99:19): explicit T=Long resolves to SOption(SLong)', () => {
    const sig = methodSignature(99, 19)
    expect(sig).toBeDefined()
    const tpe = resolveReturnTpe(sig!, { tag: 'SBox' }, [{ tag: 'SInt' }], { T: SLONG })
    expect(tpe).toEqual({ tag: 'SOption', elem: SLONG })
  })

  it('Context.getVarFromInput (101:12): explicit T=Boolean resolves to SOption(SBoolean)', () => {
    const sig = methodSignature(101, 12)
    expect(sig).toBeDefined()
    const tpe = resolveReturnTpe(
      sig!,
      { tag: 'SContext' },
      [{ tag: 'SShort' }, { tag: 'SByte' }],
      { T: SBOOLEAN }
    )
    expect(tpe).toEqual({ tag: 'SOption', elem: SBOOLEAN })
  })

  it('GroupElement.expUnsigned (7:6): closed tRange SGroupElement', () => {
    const sig = methodSignature(7, 6)
    expect(sig).toBeDefined()
    const tpe = resolveReturnTpe(
      sig!,
      { tag: 'SGroupElement' },
      [{ tag: 'SUnsignedBigInt' }],
      {}
    )
    expect(tpe).toEqual({ tag: 'SGroupElement' })
  })
})
