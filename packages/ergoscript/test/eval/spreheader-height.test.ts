/**
 * SPreHeader.height handler (typeId 105, methodId 5).
 *
 * Pattern A cost 10 (charged before obj check). Returns `height` as `SInt`
 * (i32 in sigma-rust). Mirrors sigma-rust
 * `ergotree-interpreter/src/eval/spreheader.rs:32-36` (`HEIGHT_EVAL_FN`).
 *
 * Descriptor: `ergotree-ir/src/types/spreheader.rs:26,73-77` —
 * `HEIGHT_METHOD_ID = MethodId(5)` returns `SType::SInt`.
 *
 * Total eval cost (success via Context.preHeader.height chain):
 *   4 (outer dispatcher) + 4 (inner dispatcher) + 1 (Context arm)
 *   + 15 (SContext.preHeader handler) + 10 (this handler) = 34
 *
 * Total eval cost (non-PreHeader receiver throw via PropertyCall(Context, 105:5)):
 *   4 (dispatcher) + 1 (Context arm) + 10 (handler-before-throw) = 15
 *   — the +10 is the Pattern-A charge that fires BEFORE the obj.kind check.
 *
 * Mirrors iter-10 spreheader-parent-id.test.ts shape (commit 88bb2f3).
 */

import { describe, expect, it } from 'vitest'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticParentId(): Uint8Array {
  const pid = new Uint8Array(32)
  for (let i = 0; i < 32; i++) pid[i] = (i * 3 + 7) & 0xff
  return pid
}

function syntheticMinerPk(): Uint8Array {
  const pk = new Uint8Array(33)
  pk[0] = 0x03
  for (let i = 1; i < 33; i++) pk[i] = i * 2
  return pk
}

function syntheticPreHeader(height: number = 1000000): PreHeader {
  return {
    version: 3,
    parentId: syntheticParentId(),
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height,
    minerPk: syntheticMinerPk(),
    votes: new Uint8Array(3),
  }
}

describe('SPreHeader.height handler', () => {
  it('returns Int of preHeader.height via Context.preHeader chain; cost 34', () => {
    const expected = 679837 // representative mainnet-ish height
    const preHeader = syntheticPreHeader(expected)
    const ctx = makeContext({ preHeader })

    // Build Context.preHeader.height = PropertyCall(PropertyCall(Context, 101:3), 105:5).
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: innerPreHeader,
      typeId: 105,
      methodId: 5,
    }

    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Int', value: expected })
    // 4 (outer disp) + 4 (inner disp) + 1 (Context arm) + 15 (preHeader handler) + 10 (height handler) = 34
    expect(ctx.jitCost).toBe(34)
  })

  it('charges +10 BEFORE the obj-kind check (Pattern A) on non-PreHeader receiver', () => {
    // PropertyCall(Context, 105:5) — Context-obj passes through Context arm (cost 1)
    // and the handler then charges 10 before realising obj.kind !== 'PreHeader'.
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 105,
      methodId: 5,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    // SPreHeader handlers reuse 'method-not-implemented' per compact taxonomy
    // option 1 — mirrors SPreHeader.parentId + timestamp + minerPk.
    expect(err.code).toBe('method-not-implemented')
    // 4 (dispatcher) + 1 (Context arm) + 10 (handler before throw) = 15
    expect(ctx.jitCost).toBe(15)
  })

  it('returns exact height for various values (zero, large positive, max i32)', () => {
    for (const height of [0, 1, 228633, 679837, 2147483647]) {
      const preHeader = syntheticPreHeader(height)
      const ctx = makeContext({ preHeader })
      const innerPreHeader: PropertyCallExpr = {
        tag: 'PropertyCall',
        explicitTypeArgs: {},
        obj: { tag: 'Context' },
        typeId: 101,
        methodId: 3,
      }
      const e: PropertyCallExpr = {
        tag: 'PropertyCall',
        explicitTypeArgs: {},
        obj: innerPreHeader,
        typeId: 105,
        methodId: 5,
      }
      const result = evalPropertyCall(e, Env.empty(), ctx)
      expect(result).toEqual({ kind: 'Int', value: height })
    }
  })

  it('throws context-field-missing when ctx.preHeader is undefined (via inner chain)', () => {
    // Context.preHeader handler throws context-field-missing FIRST — the height
    // handler is never reached. This mirrors the SPreHeader.parentId/timestamp/minerPk
    // precedent (the load-bearing missing-preHeader error happens at the inner
    // SContext.preHeader arm, not at the SPreHeader.* handler).
    const ctx = makeContext({})
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: innerPreHeader,
      typeId: 105,
      methodId: 5,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })
})
