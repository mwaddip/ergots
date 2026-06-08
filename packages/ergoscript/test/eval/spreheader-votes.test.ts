/**
 * SPreHeader.votes handler (typeId 105, methodId 7).
 *
 * Pattern A cost 10 (charged before obj check). Returns the 3-byte `votes` as
 * `Coll[Byte]` via `bytesToCollByteSValue` (per-byte sign-extend; same helper
 * the SPreHeader.parentId handler at 105:2 uses). No version gate (v1+).
 * JVM `methods.scala:1847` (SPreHeaderMethods), `FixedCost(JitCost(10))`.
 *
 * Total eval cost (success via Context.preHeader.votes chain):
 *   4 (outer dispatcher) + 4 (inner dispatcher) + 1 (Context arm)
 *   + 15 (SContext.preHeader handler) + 10 (this handler) = 34
 *
 * Total eval cost (non-PreHeader receiver throw via PropertyCall(Context, 105:7)):
 *   4 (dispatcher) + 1 (Context arm) + 10 (handler-before-throw) = 15
 */

import { describe, expect, it } from 'vitest'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticVotes(): Uint8Array {
  return new Uint8Array([0x69, 0x27, 0x03])
}

function syntheticPreHeader(votes: Uint8Array = syntheticVotes()): PreHeader {
  return {
    version: 3,
    parentId: new Uint8Array(32),
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height: 1000000,
    minerPk: new Uint8Array(33),
    votes,
  }
}

function preHeaderVotesCall(): PropertyCallExpr {
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
    methodId: 7,
  }
}

describe('SPreHeader.votes handler', () => {
  it('returns Coll[Byte] of the 3-byte votes via Context.preHeader chain; cost 34', () => {
    const votes = syntheticVotes()
    const ctx = makeContext({ preHeader: syntheticPreHeader(votes) })

    const result = evalPropertyCall(preHeaderVotesCall(), Env.empty(), ctx)
    expect(result.kind).toBe('Coll')
    if (result.kind !== 'Coll') throw new Error('unreachable')
    expect(result.elem).toEqual({ tag: 'SByte' })
    expect(result.items.length).toBe(3)
    for (let i = 0; i < 3; i++) {
      const item = result.items[i]!
      expect(item.kind).toBe('Byte')
      if (item.kind !== 'Byte') throw new Error('unreachable')
      expect(item.value & 0xff).toBe(votes[i]!)
    }
    // 4 (outer disp) + 4 (inner disp) + 1 (Context arm) + 15 (preHeader handler) + 10 (votes handler) = 34
    expect(ctx.jitCost).toBe(34)
  })

  it('charges +10 BEFORE the obj-kind check (Pattern A) on non-PreHeader receiver', () => {
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 105,
      methodId: 7,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
    // 4 (dispatcher) + 1 (Context arm) + 10 (handler before throw) = 15
    expect(ctx.jitCost).toBe(15)
  })

  it('sign-extends each vote byte (0xff -> -1, 0x80 -> -128, 0x7f -> 127)', () => {
    const votes = new Uint8Array([0xff, 0x80, 0x7f])
    const ctx = makeContext({ preHeader: syntheticPreHeader(votes) })
    const result = evalPropertyCall(preHeaderVotesCall(), Env.empty(), ctx)
    expect(result.kind).toBe('Coll')
    if (result.kind !== 'Coll') throw new Error('unreachable')
    expect(result.items[0]).toEqual({ kind: 'Byte', value: -1 })
    expect(result.items[1]).toEqual({ kind: 'Byte', value: -128 })
    expect(result.items[2]).toEqual({ kind: 'Byte', value: 0x7f })
  })
})
