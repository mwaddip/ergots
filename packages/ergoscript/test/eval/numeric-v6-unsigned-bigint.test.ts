import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall as MC, SValue, SType } from '../../src/mir/types'

const SUBI: SType = { tag: 'SUnsignedBigInt' }
const SINT: SType = { tag: 'SInt' }
const v3 = () => makeContext({ treeVersion: 3 })
const ubi = (value: bigint): SValue => ({ kind: 'UnsignedBigInt', value })
const bytesColl = (...vs: number[]): SValue =>
  ({ kind: 'Coll', elem: { tag: 'SByte' }, items: vs.map((v) => ({ kind: 'Byte', value: (v << 24) >> 24 })) })
const bools = (...bs: boolean[]): SValue =>
  ({ kind: 'Coll', elem: { tag: 'SBoolean' }, items: bs.map((b) => ({ kind: 'Boolean', value: b })) })
const unary = (methodId: number, v: bigint): MC =>
  ({ tag: 'MethodCall', obj: { tag: 'Const', tpe: SUBI, value: ubi(v) } as any, args: [], typeId: 9, methodId, explicitTypeArgs: {} })
const binary = (methodId: number, a: bigint, b: bigint): MC =>
  ({ tag: 'MethodCall', obj: { tag: 'Const', tpe: SUBI, value: ubi(a) } as any, args: [{ tag: 'Const', tpe: SUBI, value: ubi(b) } as any], typeId: 9, methodId, explicitTypeArgs: {} })
const shift = (methodId: number, v: bigint, bits: number): MC =>
  ({ tag: 'MethodCall', obj: { tag: 'Const', tpe: SUBI, value: ubi(v) } as any, args: [{ tag: 'Const', tpe: SINT, value: { kind: 'Int', value: bits } } as any], typeId: 9, methodId, explicitTypeArgs: {} })
const MAX = (1n << 256n) - 1n
function expectThrow(fn: () => unknown, code: string) {
  let threw: EvalError | undefined
  try { fn() } catch (e) { threw = e as EvalError }
  expect(threw).toBeInstanceOf(EvalError); expect(threw?.code).toBe(code)
}

describe('numeric v6 UnsignedBigInt arms', () => {
  it('toBytes (6): unsigned magnitude, 0n -> [] (empty)', () => {
    expect(evalMethodCall(unary(6, 0n), Env.empty(), v3())).toEqual(bytesColl())          // []
    expect(evalMethodCall(unary(6, 255n), Env.empty(), v3())).toEqual(bytesColl(0xff))     // 1 byte, no sign pad
    expect(evalMethodCall(unary(6, 256n), Env.empty(), v3())).toEqual(bytesColl(0x01, 0x00))
    expect(evalMethodCall(unary(6, MAX), Env.empty(), v3())).toEqual(bytesColl(...Array(32).fill(0xff)))
  })
  it('toBits (7): minimal-width, 0n -> [] ; 0x80 -> 10000000', () => {
    expect(evalMethodCall(unary(7, 0n), Env.empty(), v3())).toEqual(bools())               // []
    expect(evalMethodCall(unary(7, 0x80n), Env.empty(), v3())).toEqual(bools(true, ...Array(7).fill(false)))
  })
  it('bitwiseInverse (8): 256-bit flip = MAX - x (NOT signed ~x)', () => {
    expect(evalMethodCall(unary(8, 0n), Env.empty(), v3())).toEqual(ubi(MAX))
    expect(evalMethodCall(unary(8, 1n), Env.empty(), v3())).toEqual(ubi(MAX - 1n))
    expect(evalMethodCall(unary(8, 5n), Env.empty(), v3())).toEqual(ubi(MAX - 5n))   // signed BigInt would be -6n
    const once = evalMethodCall(unary(8, 12345n), Env.empty(), v3()) as { value: bigint }
    expect(evalMethodCall(unary(8, once.value), Env.empty(), v3())).toEqual(ubi(12345n))
  })
  it('or/and/xor (9/10/11)', () => {
    expect(evalMethodCall(binary(9, 0xf0n, 0x0fn), Env.empty(), v3())).toEqual(ubi(0xffn))
    expect(evalMethodCall(binary(10, 0xffn, 0x0fn), Env.empty(), v3())).toEqual(ubi(0x0fn))
    expect(evalMethodCall(binary(11, 0xffn, 0x0fn), Env.empty(), v3())).toEqual(ubi(0xf0n))
  })
  it('shiftLeft (12): in-range; overflow -> unsigned-bigint-out-of-range; bits>=256 -> numeric-shift-out-of-range', () => {
    expect(evalMethodCall(shift(12, 3n, 8), Env.empty(), v3())).toEqual(ubi(768n))
    expectThrow(() => evalMethodCall(shift(12, 1n << 255n, 1), Env.empty(), v3()), 'unsigned-bigint-out-of-range') // 2^256
    expectThrow(() => evalMethodCall(shift(12, 1n, 256), Env.empty(), v3()), 'numeric-shift-out-of-range')
  })
  it('shiftRight (13): in-range', () => {
    expect(evalMethodCall(shift(13, 768n, 8), Env.empty(), v3())).toEqual(ubi(3n))
  })
  it('wrong-kind receiver -> numeric-method-bad-operand', () => {
    const bad: MC = { tag: 'MethodCall', obj: { tag: 'Const', tpe: SUBI, value: { kind: 'BigInt', value: 5n } } as any, args: [], typeId: 9, methodId: 6, explicitTypeArgs: {} }
    expectThrow(() => evalMethodCall(bad, Env.empty(), v3()), 'numeric-method-bad-operand')
  })
  it('cost: unary=14, binary=19', () => {
    const c1 = v3(); evalMethodCall(unary(6, 5n), Env.empty(), c1); expect(c1.jitCost).toBe(14)
    const c2 = v3(); evalMethodCall(binary(9, 1n, 2n), Env.empty(), c2); expect(c2.jitCost).toBe(19)
  })
  it('v5 tree (treeVersion 2): tree-version-too-low', () => {
    expectThrow(() => evalMethodCall(unary(6, 5n), Env.empty(), makeContext({ treeVersion: 2 })), 'tree-version-too-low')
  })
})
