import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

const NUM_TPE: Record<string, SType> = {
  Byte: { tag: 'SByte' }, Short: { tag: 'SShort' }, Int: { tag: 'SInt' },
  Long: { tag: 'SLong' },
}
const TID: Record<string, number> = { Byte: 2, Short: 3, Int: 4, Long: 5 }

function num(kind: string, value: number | bigint): SValue {
  return { kind, value } as SValue
}
function call(kind: string, methodId: number, value: number | bigint): MethodCallExpr {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Const', tpe: NUM_TPE[kind]!, value: num(kind, value) } as any,
    args: [],
    typeId: TID[kind]!,
    methodId,
    explicitTypeArgs: {},
  }
}
const v3 = () => makeContext({ treeVersion: 3 })
function bools(...bs: boolean[]): SValue {
  return { kind: 'Coll', elem: { tag: 'SBoolean' }, items: bs.map((b) => ({ kind: 'Boolean', value: b })) }
}
function bytesColl(...vs: number[]): SValue {
  return { kind: 'Coll', elem: { tag: 'SByte' }, items: vs.map((v) => ({ kind: 'Byte', value: (v << 24) >> 24 })) }
}

describe('numeric v6 toBytes/toBits (fixed-width)', () => {
  it('toBytes: big-endian width bytes', () => {
    const ctx = v3()
    expect(evalMethodCall(call('Int', 6, 0x12131415), Env.empty(), ctx)).toEqual(bytesColl(0x12, 0x13, 0x14, 0x15))
    expect(ctx.jitCost).toBe(14)
    expect(evalMethodCall(call('Byte', 6, 127), Env.empty(), v3())).toEqual(bytesColl(127))
    expect(evalMethodCall(call('Short', 6, -32768), Env.empty(), v3())).toEqual(bytesColl(0x80, 0x00))
    expect(evalMethodCall(call('Long', 6, 1n), Env.empty(), v3())).toEqual(bytesColl(0, 0, 0, 0, 0, 0, 0, 1))
  })

  it('toBits: 8 bits per byte, MSB-first', () => {
    expect(evalMethodCall(call('Byte', 7, 83), Env.empty(), v3())).toEqual(
      bools(false, true, false, true, false, false, true, true),
    )
    expect(evalMethodCall(call('Byte', 7, -1), Env.empty(), v3())).toEqual(bools(...Array(8).fill(true)))
    // Short 0x0102 → bytes [0x01,0x02] → MSB-first bits
    expect(evalMethodCall(call('Short', 7, 0x0102), Env.empty(), v3())).toEqual(
      bools(false, false, false, false, false, false, false, true, false, false, false, false, false, false, true, false),
    )
    // Long Long.MinValue (0x8000_0000_0000_0000) → first bit true, then 63 false
    expect(evalMethodCall(call('Long', 7, -9223372036854775808n), Env.empty(), v3())).toEqual(
      bools(true, ...Array(63).fill(false)),
    )
    const ctx = v3()
    evalMethodCall(call('Int', 7, 0), Env.empty(), ctx)
    expect(ctx.jitCost).toBe(14)
  })

  it('gate: numeric method on treeVersion < 3 throws tree-version-too-low', () => {
    let threw: EvalError | undefined
    try {
      evalMethodCall(call('Int', 6, 1), Env.empty(), makeContext({ treeVersion: 2 }))
    } catch (e) {
      threw = e as EvalError
    }
    expect(threw).toBeInstanceOf(EvalError)
    expect(threw?.code).toBe('tree-version-too-low')
  })
})
