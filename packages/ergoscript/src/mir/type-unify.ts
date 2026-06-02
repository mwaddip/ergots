/**
 * Type-variable unification + substitution over {@link SType}.
 *
 * A direct port of the JVM sigma-state `ast` package object
 * (`core/shared/src/main/scala/sigma/ast/package.scala:17-81`): `unifyTypes`
 * (one-directional matching of a PATTERN type against a CONCRETE type),
 * `unifyTypeLists` (pairwise unify + consistent merge), and `applySubst`
 * (substitute bound vars throughout a type). The method return-type resolver
 * (`mir/method-signatures.ts`) drives these to bind a generic method's `tRange`
 * from its call-site operands — exactly as the JVM `MethodCallSerializer`
 * does at deserialize time (`getSpecializedMethodFor` → `SMethod.specializeFor`).
 *
 * Layering: imports only `mir/types` + `mir/stype-helpers` (both IR-layer); no
 * `eval/` dependency, mirroring the JVM split (type machinery in the IR crate).
 *
 * Spec: docs/specs/2026-06-02-ergoscript-v6-p0-typevar-substitution-engine-design.md
 */

import type { SType } from './types'
import { isPrimitive, sTypeEquals } from './stype-helpers'

/** A substitution of type-variable NAMES to concrete types (JVM `STypeSubst`). */
export type STypeSubst = Map<string, SType>

/**
 * One-directional match: `t1` is the pattern (may contain `STypeVar`), `t2` the
 * concrete type. Returns the binding map (possibly empty) on success, or `null`
 * on failure. Mirrors JVM `unifyTypes` (package.scala:39-64); our `SType` union
 * has no `STypeApply`, so that case is absent.
 */
export function unifyTypes(t1: SType, t2: SType): STypeSubst | null {
  if (t1.tag === 'STypeVar') {
    if (t2.tag === 'STypeVar') return t1.name === t2.name ? new Map() : null
    return new Map([[t1.name, t2]])
  }
  if (t1.tag === 'SAny') return new Map()
  if (t1.tag === 'SColl') {
    if (t2.tag === 'SColl') return unifyTypes(t1.elem, t2.elem)
    if (t2.tag === 'STuple') return unifyTypes(t1.elem, { tag: 'SAny' })
    return null
  }
  if (t1.tag === 'SOption') {
    return t2.tag === 'SOption' ? unifyTypes(t1.elem, t2.elem) : null
  }
  if (t1.tag === 'STuple') {
    return t2.tag === 'STuple' && t1.items.length === t2.items.length
      ? unifyTypeLists(t1.items, t2.items)
      : null
  }
  if (t1.tag === 'SFunc') {
    return t2.tag === 'SFunc' && t1.args.length === t2.args.length
      ? unifyTypeLists([...t1.args, t1.result], [...t2.args, t2.result])
      : null
  }
  // JVM: "necessary for implicit conversion in Coll(bool, prop, bool)".
  if (t1.tag === 'SBoolean' && t2.tag === 'SSigmaProp') return new Map()
  // JVM `case (SPrimType(e1), SPrimType(e2)) if e1 == e2`. `SPrimType.unapply`
  // (SType.scala:338) is `allPredefTypes.find(_ == t)` — a MEMBERSHIP lookup, not
  // an `extends SPrimType` trait check. `v5PredefTypes` (SType.scala:106-109)
  // includes SBox/SAvlTree/SContext/SGlobal/SHeader/SPreHeader/SString alongside
  // the numerics — the exact set `isPrimitive`'s PRIMITIVE_TAGS holds. So a
  // same-tag predef pair like (SBox, SBox) unifies to empty here, matching JVM
  // (NOT over-broad: tag equality on a zero-payload type ⇒ both sides are that
  // predef type ⇒ JVM's `SPrimType.unapply` succeeds on both with e1 == e2).
  if (isPrimitive(t1) && t1.tag === t2.tag) return new Map()
  return null
}

/**
 * Pairwise-unify two equal-length lists, merging per-pair substitutions. A type
 * var bound to two structurally-different types is a conflict → `null`. Mirrors
 * JVM `unifyTypeLists` (package.scala:17-33), except a length mismatch → `null`
 * (JVM `.zipped` truncates; our callers always pass equal lengths for
 * well-formed calls — see spec Decision 2).
 */
export function unifyTypeLists(
  items1: readonly SType[],
  items2: readonly SType[]
): STypeSubst | null {
  if (items1.length !== items2.length) return null
  const merged: STypeSubst = new Map()
  for (let i = 0; i < items1.length; i++) {
    const s = unifyTypes(items1[i]!, items2[i]!)
    if (s === null) return null
    for (const [name, t] of s) {
      const prev = merged.get(name)
      if (prev !== undefined && !sTypeEquals(prev, t)) return null
      merged.set(name, t)
    }
  }
  return merged
}

/**
 * Substitute every `STypeVar` present in `subst` throughout `tpe`. For `SFunc`,
 * also drop substituted vars from `tpeParams` (a substituted param is no longer
 * free). Mirrors JVM `applySubst` (package.scala:72-81).
 */
export function applySubst(tpe: SType, subst: STypeSubst): SType {
  switch (tpe.tag) {
    case 'STypeVar':
      return subst.get(tpe.name) ?? tpe
    case 'SColl':
      return { tag: 'SColl', elem: applySubst(tpe.elem, subst) }
    case 'SOption':
      return { tag: 'SOption', elem: applySubst(tpe.elem, subst) }
    case 'STuple':
      return { tag: 'STuple', items: tpe.items.map((t) => applySubst(t, subst)) }
    case 'SFunc':
      return {
        tag: 'SFunc',
        args: tpe.args.map((t) => applySubst(t, subst)),
        result: applySubst(tpe.result, subst),
        tpeParams: tpe.tpeParams.filter((p) => !subst.has(p.name)),
      }
    default:
      return tpe
  }
}
