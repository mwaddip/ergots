/**
 * v6 P5a — SGlobal.deserializeTo (MethodCall, 106:4) eval handler.
 *
 * JVM source: sigma/ast/methods.scala:1906-1955 — PerItemCost(100,32,32)
 * on input bytes.length, V3-gated (isV3OrLaterErgoTreeVersion).
 *
 * Cost decomposition (consensus-load-bearing, asserted exactly):
 *   4 (MethodCall dispatcher) + 5 (Global sentinel) + 5 (Const arg) +
 *   addPerItemCost(100, 32, 32, inputLen) (handler)
 *
 * For inputLen in [1..32]:  1 chunk → handler = 100 + 32 = 132 → total = 146.
 * For inputLen = 33:        2 chunks → handler = 100 + 64 = 164 → total = 178.
 *
 * Faithfulness pins (each a fork if wrong):
 * - Trailing bytes are IGNORED — no reader exhaustion check.
 * - Cost is charged BEFORE parsing (even on parse failure).
 * - Types nested > MaxTreeDepth(110) reject with global-deserialize-failed.
 */

import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall, SType, SValue } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }
const COLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }

function collByteConst(bytes: number[]): MethodCall['args'][number] {
  const items: SValue[] = bytes.map((b) => ({ kind: 'Byte', value: b }))
  return { tag: 'Const', tpe: COLL_BYTE, value: { kind: 'Coll', elem: SBYTE, items } }
}

function deserExpr(T: SType, bytes: number[]): MethodCall {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 4,
    args: [collByteConst(bytes)],
    explicitTypeArgs: { T },
  }
}

describe('Global.deserializeTo (106:4) — v6 P5a', () => {
  // -------- value + cost (1..32 bytes = 1 chunk) --------

  it('deserializeTo[Int]([10]) → Int 5, cost 146', () => {
    // ZigZag-VLQ: 10 (raw byte) → zigzag_decode(10) = 5
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr({ tag: 'SInt' }, [10]), Env.empty(), ctx)
    expect(r).toEqual({ kind: 'Int', value: 5 })
    expect(ctx.jitCost).toBe(146)
  })

  it('deserializeTo[Byte]([7]) → Byte 7, cost 146', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(SBYTE, [7]), Env.empty(), ctx)
    expect(r).toEqual({ kind: 'Byte', value: 7 })
    expect(ctx.jitCost).toBe(146)
  })

  it('deserializeTo[Coll[Byte]]([3,1,2,3]) → Coll[Byte](1,2,3), cost 146', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(COLL_BYTE, [3, 1, 2, 3]), Env.empty(), ctx)
    expect(r).toEqual({
      kind: 'Coll',
      elem: SBYTE,
      items: [
        { kind: 'Byte', value: 1 },
        { kind: 'Byte', value: 2 },
        { kind: 'Byte', value: 3 },
      ],
    })
    expect(ctx.jitCost).toBe(146)
  })

  // -------- cost boundary: 33 bytes = 2 chunks --------

  it('deserializeTo[Coll[Byte]] of 33-byte input → cost 178', () => {
    // 32-element coll: length VLQ = 0x20 = 32, then 32 data bytes → 33 total input bytes.
    const bytes = [0x20, ...Array(32).fill(0)]
    const ctx = makeContext({ treeVersion: 3 })
    evalMethodCall(deserExpr(COLL_BYTE, bytes), Env.empty(), ctx)
    expect(ctx.jitCost).toBe(178)
  })

  // -------- FAITHFULNESS PIN: trailing bytes IGNORED --------

  it('deserializeTo[Byte]([7, 99, 99]) → Byte 7 (trailing bytes ignored)', () => {
    // JVM does NOT check reader exhaustion — trailing bytes are silently discarded.
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(SBYTE, [7, 99, 99]), Env.empty(), ctx)
    expect(r).toEqual({ kind: 'Byte', value: 7 })
  })

  // -------- error: malformed bytes --------

  it('malformed bytes for Int (empty) → EvalError(global-deserialize-failed)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    try {
      evalMethodCall(deserExpr({ tag: 'SInt' }, []), Env.empty(), ctx)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('global-deserialize-failed')
    }
  })

  // -------- V3 gate --------

  it('V3 gate — treeVersion 2 throws tree-version-too-low', () => {
    const ctx = makeContext({ treeVersion: 2 })
    expect(() => evalMethodCall(deserExpr(SBYTE, [7]), Env.empty(), ctx)).toThrowError(EvalError)
  })

  // -------- MaxTreeDepth(110) bound --------

  it('deserializeTo with type nested > 110 deep throws global-deserialize-failed', () => {
    // Build SColl[SColl[...SColl[SByte]...]] nested 111 levels.
    let T: SType = { tag: 'SByte' }
    for (let i = 0; i < 111; i++) T = { tag: 'SColl', elem: T }
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMethodCall(deserExpr(T, [0]), Env.empty(), ctx)).toThrowError(EvalError)
    try {
      evalMethodCall(deserExpr(T, [0]), Env.empty(), makeContext({ treeVersion: 3 }))
    } catch (e) {
      expect((e as EvalError).code).toBe('global-deserialize-failed')
    }
  })
})
