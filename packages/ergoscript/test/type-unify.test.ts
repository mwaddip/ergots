/**
 * mir/type-unify.ts — type-var unification + substitution engine (v6 P0).
 * Ports JVM sigma-state ast/package.scala unifyTypes/unifyTypeLists/applySubst.
 * Spec: docs/specs/2026-06-02-ergoscript-v6-p0-typevar-substitution-engine-design.md
 */
import { describe, it, expect } from 'vitest'
import { unifyTypes, unifyTypeLists, applySubst } from '../src/mir/type-unify'
import type { STypeSubst } from '../src/mir/type-unify'
import type { SType } from '../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBOOL: SType = { tag: 'SBoolean' }
const SSIGMA: SType = { tag: 'SSigmaProp' }
const SANY: SType = { tag: 'SAny' }
const tv = (name: string): SType => ({ tag: 'STypeVar', name })
const coll = (elem: SType): SType => ({ tag: 'SColl', elem })
const opt = (elem: SType): SType => ({ tag: 'SOption', elem })
const tup = (...items: SType[]): SType => ({ tag: 'STuple', items })
const func = (
  args: SType[],
  result: SType,
  tpeParams: { name: string }[] = []
): SType => ({ tag: 'SFunc', args, result, tpeParams })
const sub = (entries: [string, SType][]): STypeSubst => new Map(entries)

describe('type-unify — unifyTypes', () => {
  it('binds a type var to a concrete type', () => {
    expect(unifyTypes(tv('T'), SLONG)).toEqual(sub([['T', SLONG]]))
  })
  it('two type vars: same name → empty subst, different name → null', () => {
    expect(unifyTypes(tv('T'), tv('T'))).toEqual(new Map())
    expect(unifyTypes(tv('T'), tv('U'))).toBeNull()
  })
  it('Coll[T] vs Coll[Long] binds T→Long', () => {
    expect(unifyTypes(coll(tv('T')), coll(SLONG))).toEqual(sub([['T', SLONG]]))
  })
  it('Coll[T] vs STuple binds T→SAny (JVM collection-of-tuple case)', () => {
    expect(unifyTypes(coll(tv('T')), tup(SINT, SLONG))).toEqual(sub([['T', SANY]]))
  })
  it('Option[T] vs Option[Int] binds T→Int', () => {
    expect(unifyTypes(opt(tv('T')), opt(SINT))).toEqual(sub([['T', SINT]]))
  })
  it('STuple unifies element-wise; arity mismatch → null', () => {
    expect(unifyTypes(tup(tv('A'), tv('B')), tup(SINT, SLONG))).toEqual(
      sub([['A', SINT], ['B', SLONG]])
    )
    expect(unifyTypes(tup(tv('A')), tup(SINT, SLONG))).toBeNull()
  })
  it('SFunc unifies args and result', () => {
    expect(unifyTypes(func([tv('T')], coll(tv('T'))), func([SINT], coll(SINT)))).toEqual(
      sub([['T', SINT]])
    )
  })
  it('SBoolean vs SSigmaProp → empty subst (implicit conversion)', () => {
    expect(unifyTypes(SBOOL, SSIGMA)).toEqual(new Map())
  })
  it('matching primitive → empty subst; mismatched primitive → null', () => {
    expect(unifyTypes(SBYTE, SBYTE)).toEqual(new Map())
    expect(unifyTypes(SBYTE, SINT)).toBeNull()
  })
  it('SAny pattern matches anything → empty subst', () => {
    expect(unifyTypes(SANY, coll(SLONG))).toEqual(new Map())
  })
  it('composite pattern vs bare SAny → null (cascade falls through)', () => {
    expect(unifyTypes(coll(tv('T')), SANY)).toBeNull()
  })
})

describe('type-unify — unifyTypeLists', () => {
  it('merges consistent bindings across pairs', () => {
    expect(unifyTypeLists([coll(tv('T')), tv('T')], [coll(SLONG), SLONG])).toEqual(
      sub([['T', SLONG]])
    )
  })
  it('conflicting binding of the same var → null', () => {
    expect(unifyTypeLists([tv('T'), tv('T')], [SINT, SLONG])).toBeNull()
  })
  it('length mismatch → null (strict; JVM .zipped would truncate)', () => {
    expect(unifyTypeLists([tv('T')], [SINT, SLONG])).toBeNull()
  })
})

describe('type-unify — applySubst', () => {
  it('substitutes a bare var; leaves an unbound var unchanged', () => {
    expect(applySubst(tv('T'), sub([['T', SLONG]]))).toEqual(SLONG)
    expect(applySubst(tv('U'), sub([['T', SLONG]]))).toEqual(tv('U'))
  })
  it('substitutes inside Coll / Option / STuple', () => {
    expect(applySubst(coll(tv('T')), sub([['T', SLONG]]))).toEqual(coll(SLONG))
    expect(applySubst(opt(tv('T')), sub([['T', SINT]]))).toEqual(opt(SINT))
    expect(applySubst(tup(tv('A'), SBYTE), sub([['A', SINT]]))).toEqual(tup(SINT, SBYTE))
  })
  it('substitutes inside SFunc and drops substituted tpeParams', () => {
    expect(
      applySubst(func([tv('T')], coll(tv('T')), [{ name: 'T' }]), sub([['T', SLONG]]))
    ).toEqual(func([SLONG], coll(SLONG), []))
  })
  it('leaves a primitive unchanged', () => {
    expect(applySubst(SBYTE, sub([['T', SLONG]]))).toEqual(SBYTE)
  })
})
