/**
 * SContext.minerPubKey handler (typeId 101, methodId 10).
 *
 * Pattern A cost 20 (charged before obj check). Returns the 33-byte
 * SEC1-compressed secp256k1 miner public key as a Coll[Byte]. Mirrors
 * sigma-rust `ergotree-interpreter/src/eval/scontext.rs:101-115`
 * (`MINER_PUBKEY_EVAL_FN`).
 *
 * Total eval cost (success): 4 (dispatcher) + 1 (Context arm) + 20 (handler) = 25.
 * Total eval cost (non-Context throw via Global obj): 4 + 5 + 20 = 29 — the +20
 * is the Pattern-A charge that fires BEFORE the obj.kind check.
 *
 * The descriptor at `ergotree-ir/src/types/scontext.rs:151-164` declares
 * `MINER_PUBKEY_PROPERTY_METHOD_ID = MethodId(10)` returning `SColl(SByte)`.
 */

import { describe, expect, it } from 'vitest'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader, SValue } from '../../src/mir/types'

/**
 * Hand-crafted 33-byte miner pubkey for tests. The SEC1 prefix (0x02) marks
 * a compressed point with even Y; the handler does NOT validate curve membership
 * — it just wraps the bytes as Coll[Byte] — so any 33 bytes are legal input.
 */
function syntheticMinerPk(): Uint8Array {
  const pk = new Uint8Array(33)
  pk[0] = 0x02
  // Sprinkle a recognisable pattern in the body so a wire-level mismatch
  // would show up clearly in test diffs.
  for (let i = 1; i < 33; i++) pk[i] = i
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

const minerPubKeyExpr: PropertyCallExpr = {
  tag: 'PropertyCall',
  obj: { tag: 'Context' },
  typeId: 101,
  methodId: 10,
}

describe('SContext.minerPubKey handler', () => {
  it('returns Coll[Byte] of the 33-byte miner pubkey and charges 4 + 1 + 20 = 25', () => {
    const minerPk = syntheticMinerPk()
    const ctx = makeContext({ preHeader: syntheticPreHeader(minerPk) })
    const result = evalPropertyCall(minerPubKeyExpr, Env.empty(), ctx)

    // Coll[Byte] with 33 items; each byte sign-extended to i32 (matches the
    // parser convention used by bytesToCollByteSValue).
    const expectedItems: SValue[] = []
    for (let i = 0; i < 33; i++) {
      expectedItems.push({ kind: 'Byte', value: (minerPk[i]! << 24) >> 24 })
    }
    expect(result).toEqual({
      kind: 'Coll',
      elem: { tag: 'SByte' },
      items: expectedItems,
    })
    expect(ctx.jitCost).toBe(25)
  })

  it('charges +20 BEFORE the obj-kind check (Pattern A) on non-Context receiver', () => {
    // obj = Global → Global arm charges 5; handler then charges 20 and only
    // then checks obj.kind !== 'Context'. ctx.jitCost after the throw should
    // include the +20 (proving Pattern A ordering).
    const nonContextExpr: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Global' },
      typeId: 101,
      methodId: 10,
    }
    const ctx = makeContext({ preHeader: syntheticPreHeader() })
    const err = captureEvalError(() => evalPropertyCall(nonContextExpr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-obj-not-context')
    // 4 (PropertyCall dispatcher) + 5 (Global arm) + 20 (handler before throw) = 29
    expect(ctx.jitCost).toBe(29)
  })

  it('throws context-field-missing when ctx.preHeader is undefined', () => {
    const ctx = makeContext({})
    const err = captureEvalError(() => evalPropertyCall(minerPubKeyExpr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })
})
