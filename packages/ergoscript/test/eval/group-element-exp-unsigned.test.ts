/**
 * v6 P7a — SGroupElement.expUnsigned (MethodCall, 7:6) eval handler.
 *
 * JVM source: methods.scala:656-660 — ExponentiateUnsignedMethod,
 * Exponentiate.costKind = FixedCost(JitCost(900)) (trees.scala:1042-1046),
 * v6-gated (inline isV3OrLaterErgoTreeVersion in SGroupElementMethods).
 * CGroupElement.expUnsigned (CGroupElement.scala:25-26) = the IDENTICAL
 * CryptoFacade.exponentiatePoint call as exp; only the scalar source differs.
 *
 * Blessed vectors (LanguageSpecificationV6.scala:2475-2493):
 *   g^1 = g  ·  g^0 = identity  ·  g^order = identity
 *
 * Cost (DERIVED — consensus-load-bearing, asserted exactly):
 *   Const(GE).expUnsigned(Const UBI): 4 (dispatcher) + 5 (Const obj)
 *   + 5 (Const arg) + 900 (handler) = 914
 *
 * Modeled on test/eval/global-some-none.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall as MethodCallExpr, SType } from '../../src/mir/types'

const SGE: SType = { tag: 'SGroupElement' }
const SUBI: SType = { tag: 'SUnsignedBigInt' }

// secp256k1 generator G, SEC1-compressed.
const G_HEX = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
// secp256k1 group order n.
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
}

const IDENTITY = new Uint8Array(33) // Ergo identity convention: 33 zero bytes

function expUnsignedExpr(geBytes: Uint8Array, k: bigint): MethodCallExpr {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Const', tpe: SGE, value: { kind: 'GroupElement', value: geBytes } },
    typeId: 7,
    methodId: 6,
    args: [{ tag: 'Const', tpe: SUBI, value: { kind: 'UnsignedBigInt', value: k } }],
    explicitTypeArgs: {},
  }
}

describe('SGroupElement.expUnsigned (7:6) handler — v6 P7a', () => {
  it('g^1 = g (blessed), cost 914', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(expUnsignedExpr(hexToBytes(G_HEX), 1n), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'GroupElement', value: hexToBytes(G_HEX) })
    expect(ctx.jitCost).toBe(914)
  })

  it('g^0 = identity (blessed)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(expUnsignedExpr(hexToBytes(G_HEX), 0n), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'GroupElement', value: IDENTITY })
    expect(ctx.jitCost).toBe(914)
  })

  it('g^order = identity (blessed)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(expUnsignedExpr(hexToBytes(G_HEX), ORDER), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'GroupElement', value: IDENTITY })
    expect(ctx.jitCost).toBe(914)
  })

  it('identity^5 = identity (identity-base guard)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(expUnsignedExpr(IDENTITY, 5n), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'GroupElement', value: IDENTITY })
  })

  it('rejects at treeVersion 2 with tree-version-too-low', () => {
    const ctx = makeContext({ treeVersion: 2 })
    expect(() => evalMethodCall(expUnsignedExpr(hexToBytes(G_HEX), 1n), Env.empty(), ctx))
      .toThrowError(expect.objectContaining({ code: 'tree-version-too-low' }))
  })

  it('rejects a non-GroupElement obj (adversarial pin 7)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
      typeId: 7,
      methodId: 6,
      args: [{ tag: 'Const', tpe: SUBI, value: { kind: 'UnsignedBigInt', value: 1n } }],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMethodCall(expr, Env.empty(), ctx)).toThrow(EvalError)
  })

  it('rejects a signed-BigInt exponent (exp vs expUnsigned operand distinction)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Const', tpe: SGE, value: { kind: 'GroupElement', value: hexToBytes(G_HEX) } },
      typeId: 7,
      methodId: 6,
      args: [{ tag: 'Const', tpe: { tag: 'SBigInt' }, value: { kind: 'BigInt', value: 1n } }],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMethodCall(expr, Env.empty(), ctx)).toThrow(EvalError)
  })
})
