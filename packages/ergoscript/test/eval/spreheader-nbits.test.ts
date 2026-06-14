/**
 * SPreHeader.nBits handler (typeId 105, methodId 4).
 *
 * Pattern A cost 10 (charged before obj check). Returns `nBits` as `SLong`
 * (`BigInt(obj.value.nBits)`; the struct field is a u32 number, the accessor is
 * typed SLong — NOT a signed-i64 view like timestamp). No version gate (v1+).
 * JVM `methods.scala:1844` (SPreHeaderMethods), `FixedCost(JitCost(10))`.
 *
 * Total eval cost (success via Context.preHeader.nBits chain):
 *   4 (outer dispatcher) + 4 (inner dispatcher) + 1 (Context arm)
 *   + 15 (SContext.preHeader handler) + 10 (this handler) = 34
 *
 * Total eval cost (non-PreHeader receiver throw via PropertyCall(Context, 105:4)):
 *   4 (dispatcher) + 1 (Context arm) + 10 (handler-before-throw) = 15
 */

import { describe, expect, it } from 'vitest'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticPreHeader(nBits: number = 0x18000000): PreHeader {
  return {
    version: 3,
    parentId: new Uint8Array(32),
    timestamp: 1700000000000n,
    nBits,
    height: 1000000,
    minerPk: new Uint8Array(33),
    votes: new Uint8Array(3),
  }
}

function preHeaderNBitsCall(): PropertyCallExpr {
  const innerPreHeader: PropertyCallExpr = {
    tag: 'PropertyCall',
    explicitTypeArgs: {},
    obj: { tag: 'Context' },
    typeId: 101,
    methodId: 3,
  }
  return {
    tag: 'PropertyCall',
    explicitTypeArgs: {},
    obj: innerPreHeader,
    typeId: 105,
    methodId: 4,
  }
}

describe('SPreHeader.nBits handler', () => {
  it('returns Long of preHeader.nBits via Context.preHeader chain; cost 34', () => {
    const nBits = 0x18000000
    const ctx = makeContext({ preHeader: syntheticPreHeader(nBits) })

    const result = evalPropertyCall(preHeaderNBitsCall(), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Long', value: BigInt(nBits) })
    // 4 (outer disp) + 4 (inner disp) + 1 (Context arm) + 15 (preHeader handler) + 10 (nBits handler) = 34
    expect(ctx.jitCost).toBe(34)
  })

  it('charges +10 BEFORE the obj-kind check (Pattern A) on non-PreHeader receiver', () => {
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 105,
      methodId: 4,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
    // 4 (dispatcher) + 1 (Context arm) + 10 (handler before throw) = 15
    expect(ctx.jitCost).toBe(15)
  })

  it('returns the full u32 nBits as a POSITIVE Long (no i64 sign-view)', () => {
    // Unlike timestamp (signed i64 view), nBits is a plain u32 → Long. Max u32
    // (0xFFFFFFFF = 4294967295) must surface as +4294967295n, not -1n.
    const cases: [number, bigint][] = [
      [0, 0n],
      [1, 1n],
      [0x18000000, 402653184n],
      [0xffffffff, 4294967295n],
    ]
    for (const [nBits, expected] of cases) {
      const ctx = makeContext({ preHeader: syntheticPreHeader(nBits) })
      const result = evalPropertyCall(preHeaderNBitsCall(), Env.empty(), ctx)
      expect(result).toEqual({ kind: 'Long', value: expected })
    }
  })
})
