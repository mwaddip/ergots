import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

// Out-of-signed-256 EvalError code — reused from byte-array-to-bigint.ts.
const OUT_OF_256_CODE = 'byte-array-to-bigint-out-of-range'

const SBIGINT: SType = { tag: 'SBigInt' }
const SINT: SType = { tag: 'SInt' }
const v3 = () => makeContext({ treeVersion: 3 })
function big(value: bigint): SValue { return { kind: 'BigInt', value } }
function bytesColl(...vs: number[]): SValue {
  return { kind: 'Coll', elem: { tag: 'SByte' }, items: vs.map((v) => ({ kind: 'Byte', value: (v << 24) >> 24 })) }
}
function unary(methodId: number, v: bigint): MethodCallExpr {
  return { tag: 'MethodCall', obj: { tag: 'Const', tpe: SBIGINT, value: big(v) } as any, args: [], typeId: 6, methodId, explicitTypeArgs: {} }
}
function binary(methodId: number, a: bigint, b: bigint): MethodCallExpr {
  return { tag: 'MethodCall', obj: { tag: 'Const', tpe: SBIGINT, value: big(a) } as any, args: [{ tag: 'Const', tpe: SBIGINT, value: big(b) } as any], typeId: 6, methodId, explicitTypeArgs: {} }
}
function shift(methodId: number, v: bigint, bits: number): MethodCallExpr {
  return { tag: 'MethodCall', obj: { tag: 'Const', tpe: SBIGINT, value: big(v) } as any, args: [{ tag: 'Const', tpe: SINT, value: { kind: 'Int', value: bits } } as any], typeId: 6, methodId, explicitTypeArgs: {} }
}
function expectThrow(fn: () => unknown, code: string) {
  let threw: EvalError | undefined
  try { fn() } catch (e) { threw = e as EvalError }
  expect(threw).toBeInstanceOf(EvalError)
  expect(threw?.code).toBe(code)
}

describe('numeric v6 BigInt arms', () => {
  it('toBytes: minimal two\'s-complement incl. sign byte; 0n -> [0x00]', () => {
    expect(evalMethodCall(unary(6, 0n), Env.empty(), v3())).toEqual(bytesColl(0x00))
    expect(evalMethodCall(unary(6, 127n), Env.empty(), v3())).toEqual(bytesColl(127))
    expect(evalMethodCall(unary(6, -32768n), Env.empty(), v3())).toEqual(bytesColl(0x80, 0x00))
    expect(evalMethodCall(unary(6, 2147483647n), Env.empty(), v3())).toEqual(bytesColl(0x7f, 0xff, 0xff, 0xff))
  })
  it('bitwiseInverse = -x-1 (signed-256, no overflow from in-range)', () => {
    expect(evalMethodCall(unary(8, -9223372036854775808n), Env.empty(), v3())).toEqual(big(9223372036854775807n))
    expect(evalMethodCall(unary(8, 5n), Env.empty(), v3())).toEqual(big(-6n))
  })
  it('or/and/xor', () => {
    expect(evalMethodCall(binary(9, 0xf0n, 0x0fn), Env.empty(), v3())).toEqual(big(0xffn))
    expect(evalMethodCall(binary(11, 0xffn, 0x0fn), Env.empty(), v3())).toEqual(big(0xf0n))
  })
  it('shiftLeft: in-range ok; bits-bound and result-overflow both throw', () => {
    expect(evalMethodCall(shift(12, 3n, 8), Env.empty(), v3())).toEqual(big(768n)) // JVM vector
    expect(evalMethodCall(shift(12, -222n, 10), Env.empty(), v3())).toEqual(big(-227328n)) // JVM vector
    // bits-bound (bits >= 256) -> numeric-shift-out-of-range (from makeShift)
    expectThrow(() => evalMethodCall(shift(12, -222n, 256), Env.empty(), v3()), 'numeric-shift-out-of-range')
    // RESULT overflow: 1n<<255n = 2^255 exceeds I256_MAX = 2^255-1 -> out-of-256 throw
    expectThrow(() => evalMethodCall(shift(12, 1n, 255), Env.empty(), v3()), OUT_OF_256_CODE)
  })
  it('shiftRight: arithmetic, in-range', () => {
    expect(evalMethodCall(shift(13, 24n, 3), Env.empty(), v3())).toEqual(big(3n))
    expect(evalMethodCall(shift(13, 1600n, 8), Env.empty(), v3())).toEqual(big(6n))
  })
})
