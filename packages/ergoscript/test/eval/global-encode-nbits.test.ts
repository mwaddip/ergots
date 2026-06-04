import { describe, expect, it } from 'vitest'
import { evalGlobalEncodeNbits } from '../../src/eval/global-encode-nbits'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SValue, MethodCall } from '../../src/mir/types'

const FAIL = 'global-encode-nbits-failed'

function encode(value: bigint, ctx = makeContext({ treeVersion: 3 })): SValue {
  return evalGlobalEncodeNbits({ kind: 'Global' }, [{ kind: 'BigInt', value }], ctx)
}

describe('Global.encodeNbits (106:6)', () => {
  it('encodes blessed vectors to Long', () => {
    expect(encode(0x12345600n)).toEqual({ kind: 'Long', value: 0x04123456n })
    expect(encode(0x7fffffn << 232n)).toEqual({ kind: 'Long', value: 0x207fffffn })
    expect(encode(-0x12345600n)).toEqual({ kind: 'Long', value: -0x1235n })
  })
  it('charges FixedCost(25) (NOT the stale sigma-rust 10)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    encode(0x12345600n, ctx)
    expect(ctx.jitCost).toBe(25)
  })
  it('rejects a non-BigInt arg at eval', () => {
    const ctx = makeContext({ treeVersion: 3 })
    try {
      evalGlobalEncodeNbits({ kind: 'Global' }, [{ kind: 'Long', value: 1n }], ctx)
      throw new Error('expected EvalError')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe(FAIL)
    }
  })
  it('dispatcher rejects 106:6 for a pre-V3 tree', () => {
    const mc: MethodCall = {
      tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 6,
      args: [{ tag: 'Const', tpe: { tag: 'SBigInt' }, value: { kind: 'BigInt', value: 0x12345600n } }],
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
  it('round-trips a real V3 encodeNbits call through evalMethodCall', () => {
    const mc: MethodCall = {
      tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 6,
      args: [{ tag: 'Const', tpe: { tag: 'SBigInt' }, value: { kind: 'BigInt', value: 0x12345600n } }],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({ treeVersion: 3 })
    expect(evalMethodCall(mc, Env.empty(), ctx)).toEqual({ kind: 'Long', value: 0x04123456n })
  })
})
