/**
 * SPreHeader.parentId handler (typeId 105, methodId 2).
 *
 * Pattern A cost 10 (charged before obj check). Returns the 32-byte
 * `parentId` as `Coll[Byte]` — contrast with SPreHeader.minerPk (105:6)
 * which returns `SGroupElement` of a raw 33-byte pubkey. Mirrors
 * sigma-rust `ergotree-interpreter/src/eval/spreheader.rs:14-18`
 * (`PARENT_ID_EVAL_FN`).
 *
 * Descriptor: `ergotree-ir/src/types/spreheader.rs:20,53-58` —
 * `PARENT_ID_METHOD_ID = MethodId(2)` returns `SColl(SByte)`.
 *
 * Total eval cost (success via Context.preHeader.parentId chain):
 *   4 (outer dispatcher) + 4 (inner dispatcher) + 1 (Context arm)
 *   + 15 (SContext.preHeader handler) + 10 (this handler) = 34
 *
 * Total eval cost (non-PreHeader receiver throw via PropertyCall(Context, 105:2)):
 *   4 (dispatcher) + 1 (Context arm) + 10 (handler-before-throw) = 15
 *   — the +10 is the Pattern-A charge that fires BEFORE the obj.kind check.
 *
 * Mirrors iter-4 spreheader-miner-pk.test.ts shape (commit 2767270).
 */

import { describe, expect, it } from 'vitest'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticParentId(): Uint8Array {
  const pid = new Uint8Array(32)
  // Recognisable byte pattern — makes diffs obvious if the wire mismatches.
  for (let i = 0; i < 32; i++) pid[i] = (i * 3 + 7) & 0xff
  return pid
}

function syntheticMinerPk(): Uint8Array {
  const pk = new Uint8Array(33)
  pk[0] = 0x03
  for (let i = 1; i < 33; i++) pk[i] = i * 2
  return pk
}

function syntheticPreHeader(parentId: Uint8Array = syntheticParentId()): PreHeader {
  return {
    version: 3,
    parentId,
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height: 1000000,
    minerPk: syntheticMinerPk(),
    votes: new Uint8Array(3),
  }
}

describe('SPreHeader.parentId handler', () => {
  it('returns Coll[Byte] of the 32-byte parentId via Context.preHeader chain; cost 34', () => {
    const parentId = syntheticParentId()
    const preHeader = syntheticPreHeader(parentId)
    const ctx = makeContext({ preHeader })

    // Build Context.preHeader.parentId = PropertyCall(PropertyCall(Context, 101:3), 105:2).
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: innerPreHeader,
      typeId: 105,
      methodId: 2,
    }

    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result.kind).toBe('Coll')
    if (result.kind !== 'Coll') throw new Error('unreachable')
    expect(result.elem).toEqual({ tag: 'SByte' })
    expect(result.items.length).toBe(32)
    // Bytes sign-extended u8 → signed i8 (range -128..127).
    for (let i = 0; i < 32; i++) {
      const item = result.items[i]!
      expect(item.kind).toBe('Byte')
      if (item.kind !== 'Byte') throw new Error('unreachable')
      // Match the byte after sign-extend round-trip.
      expect(item.value & 0xff).toBe(parentId[i]!)
    }
    // 4 (outer disp) + 4 (inner disp) + 1 (Context arm) + 15 (preHeader handler) + 10 (parentId handler) = 34
    expect(ctx.jitCost).toBe(34)
  })

  it('charges +10 BEFORE the obj-kind check (Pattern A) on non-PreHeader receiver', () => {
    // PropertyCall(Context, 105:2) — Context-obj passes through Context arm (cost 1)
    // and the handler then charges 10 before realising obj.kind !== 'PreHeader'.
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 105,
      methodId: 2,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    // SPreHeader handlers reuse 'method-not-implemented' per compact taxonomy
    // option 1 — mirrors SPreHeader.timestamp + SPreHeader.minerPk.
    expect(err.code).toBe('method-not-implemented')
    // 4 (dispatcher) + 1 (Context arm) + 10 (handler before throw) = 15
    expect(ctx.jitCost).toBe(15)
  })

  it('returns the exact bytes given on the input PreHeader (Coll[Byte] wrap)', () => {
    // Sanity: this is the load-bearing difference vs SPreHeader.minerPk (105:6).
    // minerPk passes through as SGroupElement.value (referential). parentId is
    // wrapped via bytesToCollByteSValue (per-byte sign-extend; new Coll items).
    const distinctivePid = new Uint8Array(32)
    distinctivePid[0] = 0xff
    distinctivePid[1] = 0x80
    distinctivePid[31] = 0x7f
    const preHeader = syntheticPreHeader(distinctivePid)
    const ctx = makeContext({ preHeader })
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: innerPreHeader,
      typeId: 105,
      methodId: 2,
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result.kind).toBe('Coll')
    if (result.kind !== 'Coll') throw new Error('unreachable')
    expect(result.elem).toEqual({ tag: 'SByte' })
    expect(result.items.length).toBe(32)
    // 0xff sign-extends to -1; 0x80 to -128; 0x7f stays 127.
    expect(result.items[0]).toEqual({ kind: 'Byte', value: -1 })
    expect(result.items[1]).toEqual({ kind: 'Byte', value: -128 })
    expect(result.items[31]).toEqual({ kind: 'Byte', value: 0x7f })
  })

  it('throws context-field-missing when ctx.preHeader is undefined (via inner chain)', () => {
    // Context.preHeader handler throws context-field-missing FIRST — the parentId
    // handler is never reached. This mirrors the SPreHeader.timestamp + minerPk
    // precedent (the load-bearing missing-preHeader error happens at the inner
    // SContext.preHeader arm, not at the SPreHeader.* handler).
    const ctx = makeContext({})
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: innerPreHeader,
      typeId: 105,
      methodId: 2,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })
})
