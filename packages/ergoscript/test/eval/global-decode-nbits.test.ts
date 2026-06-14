import { describe, expect, it } from 'vitest'
import { evalGlobalDecodeNbits } from '../../src/eval/global-decode-nbits'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SValue, MethodCall } from '../../src/mir/types'

const FAIL = 'global-decode-nbits-failed'

function decode(nbits: bigint, ctx = makeContext({ treeVersion: 3 })): SValue {
  return evalGlobalDecodeNbits({ kind: 'Global' }, [{ kind: 'Long', value: nbits }], ctx)
}
function expectFail(nbits: bigint): void {
  try {
    decode(nbits)
    throw new Error('expected EvalError')
  } catch (e) {
    expect(e).toBeInstanceOf(EvalError)
    expect((e as EvalError).code).toBe(FAIL)
  }
}

describe('Global.decodeNbits (106:7)', () => {
  it('JVM-blessed vectors (incl. negative output + boundary)', () => {
    expect(decode(0x207fffffn)).toEqual({ kind: 'BigInt', value: 0x7fffffn << 232n }) // bit-len 255, accept
    expect(decode(0x04923456n)).toEqual({ kind: 'BigInt', value: -0x12345600n })
    expect(decode(0x04123456n)).toEqual({ kind: 'BigInt', value: 0x12345600n })
    expect(decode(0x01003456n)).toEqual({ kind: 'BigInt', value: 0n })
  })
  it('sigma-rust eni cross-check vectors', () => {
    expect(decode(0x01123456n)).toEqual({ kind: 'BigInt', value: 0x12n })
    expect(decode(0x05123456n)).toEqual({ kind: 'BigInt', value: 0x1234560000n })
  })
  it('charges FixedCost(50) (NOT the stale sigma-rust 10), even on reject', () => {
    const ok = makeContext({ treeVersion: 3 })
    decode(0x04123456n, ok)
    expect(ok.jitCost).toBe(50)
    const bad = makeContext({ treeVersion: 3 })
    try { decode(0x23000001n, bad) } catch { /* expected */ }
    expect(bad.jitCost).toBe(50)
  })
  it('reads only the low 32 bits of the Long (truncation)', () => {
    expect(decode(0xffffffff04123456n)).toEqual({ kind: 'BigInt', value: 0x12345600n })
  })
  it('rejects when the decoded value overflows signed-256', () => {
    expectFail(0x23000001n) // size 0x23, mantissa 1 -> 1<<256 -> bit-len 257
  })
  it('rejects a negative Long (low-32 = 0xffffffff -> huge)', () => {
    expectFail(-1n)
  })
  it('rejects a non-Long arg at eval', () => {
    const ctx = makeContext({ treeVersion: 3 })
    try {
      evalGlobalDecodeNbits({ kind: 'Global' }, [{ kind: 'BigInt', value: 1n }], ctx)
      throw new Error('expected EvalError')
    } catch (e) {
      expect((e as EvalError).code).toBe(FAIL)
    }
  })
  it('dispatcher rejects 106:7 for a pre-V3 tree', () => {
    const mc: MethodCall = {
      tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 7,
      args: [{ tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 0x04123456n } }],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({ treeVersion: 2 })
    try {
      evalMethodCall(mc, Env.empty(), ctx)
      throw new Error('expected EvalError')
    } catch (e) {
      expect((e as EvalError).code).toBe('tree-version-too-low')
    }
  })
  it('round-trips a real V3 decodeNbits call through evalMethodCall', () => {
    const mc: MethodCall = {
      tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 7,
      args: [{ tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 0x04123456n } }],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({ treeVersion: 3 })
    expect(evalMethodCall(mc, Env.empty(), ctx)).toEqual({ kind: 'BigInt', value: 0x12345600n })
  })
})
