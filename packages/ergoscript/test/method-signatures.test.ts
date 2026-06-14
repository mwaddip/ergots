/**
 * mir/method-signatures.ts — method return-type resolver catalog + applier.
 *
 * A3 (2026-06-01): declarative `MethodSignature` descriptors keyed by
 * (typeId, methodId), consulted by `exprTpe`. `resolveReturnTpe` returns a
 * CLOSED tRange verbatim.
 *
 * v6 P0 (2026-06-02): a type-var tRange is now resolved by the substitution
 * engine (`mir/type-unify.ts`) — bind vars from receiver/args/explicitTypeArgs,
 * substitute into tRange; an unbindable residual falls back to SAny.
 *
 * Specs: docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md,
 *        docs/specs/2026-06-02-ergoscript-v6-p0-typevar-substitution-engine-design.md
 */
import { describe, it, expect } from 'vitest'
import { methodSignature, resolveReturnTpe } from '../src/mir/method-signatures'
import type { MethodSignature } from '../src/mir/method-signatures'
import type { SType } from '../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SGROUPELEMENT: SType = { tag: 'SGroupElement' }
const collOf = (elem: SType): SType => ({ tag: 'SColl', elem })

describe('method-signatures — catalog lookup', () => {
  it('registers getEncoded (7:2) with tRange Coll[SByte]', () => {
    const sig = methodSignature(7, 2)
    expect(sig).toBeDefined()
    expect(sig!.tRange).toEqual(collOf(SBYTE))
  })

  it('registers indices (12:14) with tRange Coll[SInt]', () => {
    const sig = methodSignature(12, 14)
    expect(sig).toBeDefined()
    expect(sig!.tRange).toEqual(collOf(SINT))
  })

  it('returns undefined for an unregistered method', () => {
    expect(methodSignature(999, 999)).toBeUndefined()
  })
})

describe('method-signatures — resolveReturnTpe', () => {
  it('returns a closed tRange verbatim (getEncoded)', () => {
    const sig = methodSignature(7, 2)!
    expect(resolveReturnTpe(sig, SGROUPELEMENT, [], {})).toEqual(collOf(SBYTE))
  })

  it('returns a closed tRange verbatim, ignoring receiver/args (indices)', () => {
    const sig = methodSignature(12, 14)!
    expect(resolveReturnTpe(sig, collOf(SLONG), [], {})).toEqual(collOf(SINT))
    expect(resolveReturnTpe(sig, collOf(SBYTE), [], {})).toEqual(collOf(SINT))
  })

  it('resolves a type-var tRange by unifying the receiver (Coll[T] ⇒ Coll[T])', () => {
    // The substitution engine binds T from the receiver's element type. This is
    // the FLIP of A3's deferred-substitution test (was → SAny).
    const genericSig: MethodSignature = {
      tDom: [collOf({ tag: 'STypeVar', name: 'T' })],
      tRange: collOf({ tag: 'STypeVar', name: 'T' }),
      tpeParams: [{ name: 'T' }],
    }
    expect(resolveReturnTpe(genericSig, collOf(SLONG), [], {})).toEqual(collOf(SLONG))
  })

  it('resolves a type-var tRange from an explicit type arg (getReg-shaped)', () => {
    // T appears only in tRange (Option[T]) — not inferable from tDom; it comes
    // from explicitTypeArgs, applied BEFORE unification (JVM withConcreteTypes).
    const getRegShaped: MethodSignature = {
      tDom: [{ tag: 'SBox' }, SINT],
      tRange: { tag: 'SOption', elem: { tag: 'STypeVar', name: 'T' } },
      tpeParams: [{ name: 'T' }],
    }
    expect(resolveReturnTpe(getRegShaped, { tag: 'SBox' }, [SINT], { T: SLONG })).toEqual({
      tag: 'SOption',
      elem: SLONG,
    })
  })

  it('falls back to SAny when the receiver cannot bind the var (bare SAny)', () => {
    const genericSig: MethodSignature = {
      tDom: [collOf({ tag: 'STypeVar', name: 'T' })],
      tRange: collOf({ tag: 'STypeVar', name: 'T' }),
      tpeParams: [{ name: 'T' }],
    }
    expect(resolveReturnTpe(genericSig, { tag: 'SAny' }, [], {})).toEqual({ tag: 'SAny' })
  })

  it('falls back to SAny on a conflicting binding', () => {
    // tDom binds T twice; receiver says Coll[Int], arg says Long → conflict → SAny.
    const conflictSig: MethodSignature = {
      tDom: [collOf({ tag: 'STypeVar', name: 'T' }), { tag: 'STypeVar', name: 'T' }],
      tRange: collOf({ tag: 'STypeVar', name: 'T' }),
      tpeParams: [{ name: 'T' }],
    }
    expect(resolveReturnTpe(conflictSig, collOf(SINT), [SLONG], {})).toEqual({ tag: 'SAny' })
  })
})
