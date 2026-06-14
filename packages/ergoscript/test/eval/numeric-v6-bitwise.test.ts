import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { exprTpe } from '../../src/mir/expr-tpe'
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

const NUM_TPE: Record<string, SType> = {
  Byte: { tag: 'SByte' }, Short: { tag: 'SShort' }, Int: { tag: 'SInt' }, Long: { tag: 'SLong' },
}
const TID: Record<string, number> = { Byte: 2, Short: 3, Int: 4, Long: 5 }
const v3 = () => makeContext({ treeVersion: 3 })
function n(kind: string, value: number | bigint): SValue { return { kind, value } as SValue }
function constE(kind: string, value: number | bigint) { return { tag: 'Const', tpe: NUM_TPE[kind]!, value: n(kind, value) } as any }
function unary(kind: string, methodId: number, value: number | bigint): MethodCallExpr {
  return { tag: 'MethodCall', obj: constE(kind, value), args: [], typeId: TID[kind]!, methodId, explicitTypeArgs: {} }
}
function binary(kind: string, methodId: number, a: number | bigint, b: number | bigint): MethodCallExpr {
  return { tag: 'MethodCall', obj: constE(kind, a), args: [constE(kind, b)], typeId: TID[kind]!, methodId, explicitTypeArgs: {} }
}

describe('numeric v6 bitwise (fixed-width)', () => {
  it('bitwiseInverse', () => {
    const ctx = v3()
    expect(evalMethodCall(unary('Byte', 8, 1), Env.empty(), ctx)).toEqual(n('Byte', -2))
    expect(ctx.jitCost).toBe(14)
    expect(evalMethodCall(unary('Int', 8, 0), Env.empty(), v3())).toEqual(n('Int', -1))
    expect(evalMethodCall(unary('Long', 8, 0n), Env.empty(), v3())).toEqual(n('Long', -1n))
    // sign-flip boundary: ~MAX = MIN per width
    expect(evalMethodCall(unary('Byte', 8, 127), Env.empty(), v3())).toEqual(n('Byte', -128))
    expect(evalMethodCall(unary('Long', 8, 9223372036854775807n), Env.empty(), v3())).toEqual(n('Long', -9223372036854775808n))
  })

  it('bitwiseOr/And/Xor', () => {
    const ctx = v3()
    expect(evalMethodCall(binary('Byte', 9, 1, 2), Env.empty(), ctx)).toEqual(n('Byte', 3))
    expect(ctx.jitCost).toBe(19)
    expect(evalMethodCall(binary('Byte', 10, 3, 5), Env.empty(), v3())).toEqual(n('Byte', 1))
    expect(evalMethodCall(binary('Byte', 11, 3, 5), Env.empty(), v3())).toEqual(n('Byte', 6))
    expect(evalMethodCall(binary('Long', 11, 0xffn, 0x0fn), Env.empty(), v3())).toEqual(n('Long', 0xf0n))
    // Short/Int sign-boundary coverage (exercise trShort/trInt end-to-end)
    expect(evalMethodCall(binary('Short', 9, -32768, 32767), Env.empty(), v3())).toEqual(n('Short', -1))
    expect(evalMethodCall(binary('Int', 10, 0x7fffffff, -1), Env.empty(), v3())).toEqual(n('Int', 2147483647))
  })

  it('P0 engine: bitwise return type resolves to the receiver numeric type', () => {
    expect(exprTpe(binary('Long', 9, 1n, 2n) as any)).toEqual({ tag: 'SLong' })
    expect(exprTpe(unary('Int', 8, 5) as any)).toEqual({ tag: 'SInt' })
  })
})
