/**
 * mir/method-signatures.ts — method return-type resolver catalog + applier.
 *
 * A3 (2026-06-01): declarative `MethodSignature` descriptors keyed by
 * (typeId, methodId), consulted by `exprTpe`. `resolveReturnTpe` returns a
 * CLOSED tRange verbatim; a type-var tRange falls back to SAny (substitution
 * deferred — no generic-output method is registered this phase).
 *
 * Spec: docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md
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

  it('falls back to SAny for a type-var tRange (substitution deferred)', () => {
    // Synthetic generic-OUTPUT signature: Coll[T] => Coll[T]. The substitution
    // engine is not built this phase, so a tRange referencing a type var must
    // resolve to SAny (the cascade) — NOT a verbatim tRange with an unbound var.
    const genericSig: MethodSignature = {
      tDom: [collOf({ tag: 'STypeVar', name: 't' })],
      tRange: collOf({ tag: 'STypeVar', name: 't' }),
      tpeParams: [{ name: 't' }],
    }
    expect(resolveReturnTpe(genericSig, collOf(SLONG), [], {})).toEqual({ tag: 'SAny' })
  })
})
