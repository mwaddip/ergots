/**
 * SPreHeader.minerPk handler (typeId 105, methodId 6).
 *
 * Pattern A cost 10 (charged before obj check). Returns the raw 33-byte
 * SEC1-compressed secp256k1 miner pubkey as an SGroupElement value — NOT a
 * Coll[Byte] (cf. SContext.minerPubKey at 101:10 which does sigma-serialize
 * to Coll[Byte]). Mirrors sigma-rust
 * `ergotree-interpreter/src/eval/spreheader.rs:38-42` (`MINER_PK_EVAL_FN`).
 *
 * Descriptor: `ergotree-ir/src/types/spreheader.rs:79-84` —
 * `MINER_PK_METHOD` returns `SType::SGroupElement`.
 *
 * Total eval cost (success via Context.preHeader.minerPk chain):
 *   4 (outer dispatcher) + 4 (inner dispatcher) + 1 (Context arm)
 *   + 15 (SContext.preHeader handler) + 10 (this handler) = 34
 *
 * Total eval cost (non-PreHeader receiver throw via PropertyCall(Context, 105:6)):
 *   4 (dispatcher) + 1 (Context arm) + 10 (handler-before-throw) = 15
 *   — the +10 is the Pattern-A charge that fires BEFORE the obj.kind check.
 */

import { describe, expect, it } from 'vitest'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticMinerPk(): Uint8Array {
  const pk = new Uint8Array(33)
  pk[0] = 0x03
  // Recognisable trailing pattern — makes diffs obvious if the wire mismatches.
  for (let i = 1; i < 33; i++) pk[i] = i * 2
  return pk
}

function syntheticPreHeader(minerPk: Uint8Array = syntheticMinerPk()): PreHeader {
  return {
    version: 3,
    parentId: new Uint8Array(32),
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height: 1000000,
    minerPk,
    votes: new Uint8Array(3),
  }
}

describe('SPreHeader.minerPk handler', () => {
  it('returns SGroupElement of the 33-byte miner pubkey via Context.preHeader chain; cost 34', () => {
    const minerPk = syntheticMinerPk()
    const preHeader = syntheticPreHeader(minerPk)
    const ctx = makeContext({ preHeader })

    // Build Context.preHeader.minerPk = PropertyCall(PropertyCall(Context, 101:3), 105:6).
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
      methodId: 6,
    }

    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'GroupElement', value: minerPk })
    // 4 (outer disp) + 4 (inner disp) + 1 (Context arm) + 15 (preHeader handler) + 10 (minerPk handler) = 34
    expect(ctx.jitCost).toBe(34)
  })

  it('charges +10 BEFORE the obj-kind check (Pattern A) on non-PreHeader receiver', () => {
    // PropertyCall(Context, 105:6) — Context-obj passes through Context arm (cost 1)
    // and the handler then charges 10 before realising obj.kind !== 'PreHeader'.
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 105,
      methodId: 6,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    // SPreHeader handlers reuse 'method-not-implemented' per compact taxonomy
    // option 1 — mirrors SPreHeader.timestamp at method-call.ts:244.
    expect(err.code).toBe('method-not-implemented')
    // 4 (dispatcher) + 1 (Context arm) + 10 (handler before throw) = 15
    expect(ctx.jitCost).toBe(15)
  })

  it('returns the exact bytes given on the input PreHeader (no serialization)', () => {
    // Sanity: this is the load-bearing difference vs SContext.minerPubKey (101:10),
    // which wraps via bytesToCollByteSValue. Here the bytes flow through unmodified
    // as SGroupElement.value. A regression that adds a serialization step would
    // change `.value` (e.g., to Coll items).
    const distinctivePk = new Uint8Array(33)
    distinctivePk[0] = 0x02
    distinctivePk[1] = 0xff
    distinctivePk[32] = 0x7f
    const preHeader = syntheticPreHeader(distinctivePk)
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
      methodId: 6,
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result.kind).toBe('GroupElement')
    if (result.kind !== 'GroupElement') throw new Error('unreachable')
    expect(result.value).toBe(distinctivePk) // referential equality — no copy
  })
})
