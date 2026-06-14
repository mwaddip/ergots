/**
 * v6 P7a — SBox.getReg (MethodCall, 99:19) eval handler + 99:7 parity pins.
 *
 * JVM source: methods.scala:1338-1347 (getRegMethodV6) —
 * ExtractRegisterAs.costKind = FixedCost(JitCost(50))
 * (transformers.scala:497-500), v6Methods-only. Eval = CBox.getReg
 * (CBox.scala:32-44) over the fixed 10-slot register array (regs(), :77-91):
 *   runtime index <0 or >9 → None · absent → None ·
 *   defined + exact type → Some · defined + mismatch → THROW
 *   ('register-type-mismatch' ≘ JVM InvalidType).
 * The id-7 sibling ("getRegV5") deserializes at every version in the JVM but
 * ALWAYS eval-throws (reflection lookup of a nonexistent name) — ergots
 * parity: unregistered → 'method-not-implemented' at every version.
 *
 * Cost (DERIVED — consensus-load-bearing, asserted exactly):
 *   Const(Box).getReg[T](Const Int): 4 (dispatcher) + 5 (Const obj)
 *   + 5 (Const arg) + 50 (handler) = 64
 *
 * Modeled on test/eval/global-some-none.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { ErgoBox, MethodCall as MethodCallExpr, SType } from '../../src/mir/types'

const SLONG: SType = { tag: 'SLong' }
const SINT: SType = { tag: 'SInt' }

// Box value 10 — mirrors the blessed JVM getReg case (R0 → Success(10L),
// LanguageSpecificationV6.scala:1286-1313; that vector exercises the
// ExtractRegisterAs lowering — here the same semantics via MethodCall 99:19).
function makeBox(overrides: Partial<ErgoBox> = {}): ErgoBox {
  return {
    value: 10n,
    ergoTreeBytes: new Uint8Array([0x08, 0x00]),
    registers: {},
    tokens: [],
    creationHeight: 0,
    txId: new Uint8Array(32),
    index: 0,
    ...overrides,
  }
}

function getRegExpr(box: ErgoBox, regId: number, t: SType, methodId = 19): MethodCallExpr {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Const', tpe: { tag: 'SBox' }, value: { kind: 'Box', value: box } },
    typeId: 99,
    methodId,
    args: [{ tag: 'Const', tpe: SINT, value: { kind: 'Int', value: regId } }],
    explicitTypeArgs: methodId === 19 ? { T: t } : {},
  }
}

describe('SBox.getReg (99:19) handler — v6 P7a', () => {
  it('getReg[Long](0) → Some(Long 10) (R0 synthesis; blessed-analog), cost 64', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(getRegExpr(makeBox(), 0, SLONG), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SLONG, value: { kind: 'Long', value: 10n } })
    expect(ctx.jitCost).toBe(64)
  })

  it('getReg[Int](4) → Some(Int 7) (non-mandatory register)', () => {
    const box = makeBox({ registers: { 4: { tpe: SINT, value: { kind: 'Int', value: 7 } } } })
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(getRegExpr(box, 4, SINT), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SINT, value: { kind: 'Int', value: 7 } })
  })

  it('getReg[Long](5) on an absent register → None', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(getRegExpr(makeBox(), 5, SLONG), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SLONG, value: null })
  })

  it('runtime index -1 → None (CBox.getReg bound — NOT register-id-out-of-range)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(getRegExpr(makeBox(), -1, SLONG), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SLONG, value: null })
  })

  it('runtime index 10 → None (fixed 10-slot array bound)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(getRegExpr(makeBox(), 10, SLONG), Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Option', elem: SLONG, value: null })
  })

  it('getReg[Long](4) on an Int register → THROWS register-type-mismatch (asymmetry pin)', () => {
    const box = makeBox({ registers: { 4: { tpe: SINT, value: { kind: 'Int', value: 7 } } } })
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMethodCall(getRegExpr(box, 4, SLONG), Env.empty(), ctx))
      .toThrowError(expect.objectContaining({ code: 'register-type-mismatch' }))
  })

  it('rejects at treeVersion 2 with tree-version-too-low', () => {
    const ctx = makeContext({ treeVersion: 2 })
    expect(() => evalMethodCall(getRegExpr(makeBox(), 0, SLONG), Env.empty(), ctx))
      .toThrowError(expect.objectContaining({ code: 'tree-version-too-low' }))
  })

  it('rejects a non-Int index arg', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Const', tpe: { tag: 'SBox' }, value: { kind: 'Box', value: makeBox() } },
      typeId: 99,
      methodId: 19,
      args: [{ tag: 'Const', tpe: SLONG, value: { kind: 'Long', value: 0n } }],
      explicitTypeArgs: { T: SLONG },
    }
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMethodCall(expr, Env.empty(), ctx)).toThrowError(/expects an Int register index/)
  })

  it('rejects extra args (arity 1 exact — JVM reflection-arity parity)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Const', tpe: { tag: 'SBox' }, value: { kind: 'Box', value: makeBox() } },
      typeId: 99,
      methodId: 19,
      args: [
        { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: 0 } },
        { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: 1 } },
      ],
      explicitTypeArgs: { T: SLONG },
    }
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMethodCall(expr, Env.empty(), ctx)).toThrowError(/expects an Int register index/)
  })
})

describe('MethodCall(99, 7) — getRegV5 eval parity (spec §2 pin 1)', () => {
  it('eval-throws method-not-implemented at treeVersion 0 (JVM: reflection throw, all versions)', () => {
    const ctx = makeContext({ treeVersion: 0 })
    expect(() => evalMethodCall(getRegExpr(makeBox(), 0, SLONG, 7), Env.empty(), ctx))
      .toThrowError(expect.objectContaining({ code: 'method-not-implemented' }))
  })

  it('eval-throws method-not-implemented at treeVersion 3 too', () => {
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMethodCall(getRegExpr(makeBox(), 0, SLONG, 7), Env.empty(), ctx))
      .toThrowError(expect.objectContaining({ code: 'method-not-implemented' }))
  })
})
