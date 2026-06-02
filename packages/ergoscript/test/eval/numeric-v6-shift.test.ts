import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

const NUM_TPE: Record<string, SType> = { Byte: { tag: 'SByte' }, Int: { tag: 'SInt' }, Long: { tag: 'SLong' } }
const TID: Record<string, number> = { Byte: 2, Int: 4, Long: 5 }
const SINT: SType = { tag: 'SInt' }
const v3 = () => makeContext({ treeVersion: 3 })
function n(kind: string, value: number | bigint): SValue { return { kind, value } as SValue }
function shift(kind: string, methodId: number, value: number | bigint, bits: number): MethodCallExpr {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Const', tpe: NUM_TPE[kind]!, value: n(kind, value) } as any,
    args: [{ tag: 'Const', tpe: SINT, value: { kind: 'Int', value: bits } } as any],
    typeId: TID[kind]!, methodId, explicitTypeArgs: {},
  }
}

describe('numeric v6 shiftLeft/shiftRight (fixed-width)', () => {
  it('shiftLeft truncates to width', () => {
    const ctx = v3()
    expect(evalMethodCall(shift('Byte', 12, 1, 1), Env.empty(), ctx)).toEqual(n('Byte', 2))
    expect(ctx.jitCost).toBe(19)
    expect(evalMethodCall(shift('Long', 12, 1n, 63), Env.empty(), v3())).toEqual(n('Long', -9223372036854775808n))
  })

  it('shiftRight is arithmetic (sign-extending)', () => {
    expect(evalMethodCall(shift('Byte', 13, -2, 1), Env.empty(), v3())).toEqual(n('Byte', -1))
    expect(evalMethodCall(shift('Int', 13, -8, 2), Env.empty(), v3())).toEqual(n('Int', -2))
  })

  it('rejects bits out of [0, width): throws numeric-shift-out-of-range', () => {
    for (const bits of [-1, 8]) {
      let threw: EvalError | undefined
      try { evalMethodCall(shift('Byte', 12, 1, bits), Env.empty(), v3()) } catch (e) { threw = e as EvalError }
      expect(threw).toBeInstanceOf(EvalError)
      expect(threw?.code).toBe('numeric-shift-out-of-range')
    }
    // boundary: bits = width-1 allowed
    expect(evalMethodCall(shift('Byte', 12, 1, 7), Env.empty(), v3())).toEqual(n('Byte', -128)) // 1<<7 = -128 (i8)
  })
})
