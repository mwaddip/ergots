/**
 * SPreHeader.version handler (typeId 105, methodId 1).
 *
 * Pattern A cost 10 (charged before obj check). Returns `version` as `SByte`
 * (sign-extended u8 → signed i8, mirroring SHeader.version at sheader.ts:60).
 * No version gate (available v1+). JVM `methods.scala:1841` (SPreHeaderMethods),
 * all 7 accessors `FixedCost(JitCost(10))`.
 *
 * Descriptor: SPreHeaderMethods.version = MethodId(1) → SType::SByte.
 *
 * Total eval cost (success via Context.preHeader.version chain):
 *   4 (outer dispatcher) + 4 (inner dispatcher) + 1 (Context arm)
 *   + 15 (SContext.preHeader handler) + 10 (this handler) = 34
 *
 * Total eval cost (non-PreHeader receiver throw via PropertyCall(Context, 105:1)):
 *   4 (dispatcher) + 1 (Context arm) + 10 (handler-before-throw) = 15
 *   — the +10 is the Pattern-A charge that fires BEFORE the obj.kind check.
 *
 * Mirrors spreheader-height.test.ts shape.
 */

import { describe, expect, it } from 'vitest'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticPreHeader(version: number = 3): PreHeader {
  return {
    version,
    parentId: new Uint8Array(32),
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height: 1000000,
    minerPk: new Uint8Array(33),
    votes: new Uint8Array(3),
  }
}

function preHeaderVersionCall(): PropertyCallExpr {
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
    methodId: 1,
  }
}

describe('SPreHeader.version handler', () => {
  it('returns Byte of preHeader.version via Context.preHeader chain; cost 34', () => {
    const preHeader = syntheticPreHeader(3)
    const ctx = makeContext({ preHeader })

    const result = evalPropertyCall(preHeaderVersionCall(), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Byte', value: 3 })
    // 4 (outer disp) + 4 (inner disp) + 1 (Context arm) + 15 (preHeader handler) + 10 (version handler) = 34
    expect(ctx.jitCost).toBe(34)
  })

  it('charges +10 BEFORE the obj-kind check (Pattern A) on non-PreHeader receiver', () => {
    // PropertyCall(Context, 105:1) — Context-obj passes through Context arm (cost 1)
    // and the handler then charges 10 before realising obj.kind !== 'PreHeader'.
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 105,
      methodId: 1,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    // SPreHeader handlers reuse 'method-not-implemented' per compact taxonomy option 1.
    expect(err.code).toBe('method-not-implemented')
    // 4 (dispatcher) + 1 (Context arm) + 10 (handler before throw) = 15
    expect(ctx.jitCost).toBe(15)
  })

  it('sign-extends the u8 version to a signed Byte (i8 view, mirrors SHeader.version)', () => {
    // version is a u8 (mir/types.ts: "u8, currently 0..7"); the Byte SValue holds
    // the signed i8 reinterpretation — values >= 128 surface as negative.
    const cases: [number, number][] = [
      [0, 0],
      [1, 1],
      [127, 127],
      [128, -128],
      [255, -1],
    ]
    for (const [version, expected] of cases) {
      const ctx = makeContext({ preHeader: syntheticPreHeader(version) })
      const result = evalPropertyCall(preHeaderVersionCall(), Env.empty(), ctx)
      expect(result).toEqual({ kind: 'Byte', value: expected })
    }
  })
})
