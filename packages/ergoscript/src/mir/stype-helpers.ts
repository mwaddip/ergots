/**
 * Structural helpers over {@link SType}: primitive detection and
 * deep structural equality. Pure functions, no side effects.
 */

import type { SType, STypeVar } from './types'

const PRIMITIVE_TAGS: ReadonlySet<SType['tag']> = new Set<SType['tag']>([
  'SBoolean',
  'SByte',
  'SShort',
  'SInt',
  'SLong',
  'SBigInt',
  'SUnsignedBigInt',
  'SGroupElement',
  'SSigmaProp',
  'SBox',
  'SAvlTree',
  'SUnit',
  'SAny',
  'SHeader',
  'SPreHeader',
  'SContext',
  'SGlobal',
  'SString'
])

/**
 * `true` when `t` is a primitive (zero-payload) `SType` — every variant
 * except the four composites (`SColl`, `STuple`, `SOption`, `SFunc`) and
 * `STypeVar`.
 *
 * Matches sigma-rust's `SType::is_prim`. `SUnsignedBigInt` is included (a v6
 * embeddable primitive).
 */
export function isPrimitive(t: SType): boolean {
  return PRIMITIVE_TAGS.has(t.tag)
}

/**
 * Deep structural equality on `SType`. Two types are equal iff their tags
 * match and (recursively) all payload fields match — collection elements,
 * tuple items in order, function args + result + type-parameter names.
 *
 * Type-parameter equality on `SFunc` compares `name` only (matching
 * `STypeVar`'s identity in sigma-rust's `STypeVar::PartialEq`).
 */
export function sTypeEquals(a: SType, b: SType): boolean {
  if (a.tag !== b.tag) return false
  switch (a.tag) {
    case 'SColl':
      return sTypeEquals(a.elem, (b as { tag: 'SColl'; elem: SType }).elem)
    case 'SOption':
      return sTypeEquals(a.elem, (b as { tag: 'SOption'; elem: SType }).elem)
    case 'STuple': {
      const bi = (b as { tag: 'STuple'; items: SType[] }).items
      if (a.items.length !== bi.length) return false
      // Lengths match -> bi[i] is defined for all i in range.
      return a.items.every((item, i) => sTypeEquals(item, bi[i]!))
    }
    case 'SFunc': {
      const bf = b as {
        tag: 'SFunc'
        args: SType[]
        result: SType
        tpeParams: STypeVar[]
      }
      if (a.args.length !== bf.args.length) return false
      // Lengths match -> bf.args[i] is defined for all i in range.
      if (!a.args.every((arg, i) => sTypeEquals(arg, bf.args[i]!))) return false
      if (!sTypeEquals(a.result, bf.result)) return false
      if (a.tpeParams.length !== bf.tpeParams.length) return false
      // Lengths match -> bf.tpeParams[i] is defined for all i in range.
      return a.tpeParams.every((tp, i) => tp.name === bf.tpeParams[i]!.name)
    }
    case 'STypeVar':
      return a.name === (b as { tag: 'STypeVar'; name: string }).name
    // Primitives — only tag matters, and tags already match. Enumerated
    // explicitly so adding a new SType variant becomes a compile-time error
    // via the `_exhaust: never` default below.
    case 'SBoolean':
      return true
    case 'SByte':
      return true
    case 'SShort':
      return true
    case 'SInt':
      return true
    case 'SLong':
      return true
    case 'SBigInt':
      return true
    case 'SUnsignedBigInt':
      return true
    case 'SGroupElement':
      return true
    case 'SSigmaProp':
      return true
    case 'SBox':
      return true
    case 'SAvlTree':
      return true
    case 'SUnit':
      return true
    case 'SAny':
      return true
    case 'SHeader':
      return true
    case 'SPreHeader':
      return true
    case 'SContext':
      return true
    case 'SGlobal':
      return true
    case 'SString':
      return true
    default: {
      const _exhaust: never = a
      return _exhaust
    }
  }
}

/**
 * SAny-tolerant structural type comparison: identical to {@link sTypeEquals}
 * EXCEPT that `SAny` on either side matches any type — at any nesting depth.
 *
 * Why this exists: our phase-2a `exprTpe` emits `SAny` as a placeholder for
 * types it can't statically resolve (notably MethodCall/PropertyCall return
 * types — there's no SMethod return-type resolver yet). That `SAny` propagates
 * through `ValDef`/`ValUse`/HOF result types and can land *nested* inside a
 * composite — e.g. a mapper whose static return type is `STuple[Coll[SByte],
 * SAny]` while the runtime value is the concrete `STuple[Coll[SByte], SLong]`.
 *
 * sigma-rust never has `SAny` here (it tracks concrete types), so its
 * equivalent checks pass; treating `SAny` as a wildcard makes our eval-time
 * type checks accept exactly what sigma-rust accepts, while still catching a
 * genuine mismatch (which has concrete types on both sides and no `SAny`).
 *
 * This generalizes the top-level-only `SAny` skips added for Map (iter-16/19)
 * and Append (iter-21): iter-22 (mainnet h=1,012,685) surfaced an `SAny` nested
 * inside a tuple element, which a top-level `.tag === 'SAny'` guard misses.
 *
 * Mirrors `sTypeEquals`'s structure exactly; the only difference is the
 * leading wildcard short-circuit applied at every recursion level.
 */
/**
 * `true` when `t` contains an `SAny` anywhere — at the top level or nested
 * inside a composite (`SColl`/`SOption`/`STuple`/`SFunc`). Used to decide
 * whether a statically-derived type is fully concrete (and thus usable as a
 * result/output type) or carries an unresolved-placeholder `SAny` that should
 * be recovered from the concrete runtime value instead.
 */
export function hasSAny(t: SType): boolean {
  switch (t.tag) {
    case 'SAny':
      return true
    case 'SColl':
    case 'SOption':
      return hasSAny(t.elem)
    case 'STuple':
      return t.items.some(hasSAny)
    case 'SFunc':
      return t.args.some(hasSAny) || hasSAny(t.result)
    default:
      return false
  }
}

/**
 * `true` when `t` contains an `STypeVar` anywhere — at the top level or nested
 * inside a composite (`SColl`/`SOption`/`STuple`/`SFunc`). Sibling to
 * {@link hasSAny}, with the same recursion structure but the `STypeVar` tag as
 * the leading hit instead of `SAny`. Used by the method-return-type resolver
 * (`mir/method-signatures.ts`) to decide whether a method's declared `t_range`
 * is CLOSED (usable verbatim) or references an unbound type var (substitution
 * deferred → falls back to `SAny`).
 */
export function hasTypeVar(t: SType): boolean {
  switch (t.tag) {
    case 'STypeVar':
      return true
    case 'SColl':
    case 'SOption':
      return hasTypeVar(t.elem)
    case 'STuple':
      return t.items.some(hasTypeVar)
    case 'SFunc':
      return t.args.some(hasTypeVar) || hasTypeVar(t.result)
    default:
      return false
  }
}

export function sTypeEqualsModuloSAny(a: SType, b: SType): boolean {
  // Wildcard: SAny (unresolved placeholder) matches anything, at any depth.
  if (a.tag === 'SAny' || b.tag === 'SAny') return true
  if (a.tag !== b.tag) return false
  switch (a.tag) {
    case 'SColl':
      return sTypeEqualsModuloSAny(a.elem, (b as { tag: 'SColl'; elem: SType }).elem)
    case 'SOption':
      return sTypeEqualsModuloSAny(a.elem, (b as { tag: 'SOption'; elem: SType }).elem)
    case 'STuple': {
      const bi = (b as { tag: 'STuple'; items: SType[] }).items
      if (a.items.length !== bi.length) return false
      return a.items.every((item, i) => sTypeEqualsModuloSAny(item, bi[i]!))
    }
    case 'SFunc': {
      const bf = b as { tag: 'SFunc'; args: SType[]; result: SType; tpeParams: STypeVar[] }
      if (a.args.length !== bf.args.length) return false
      if (!a.args.every((arg, i) => sTypeEqualsModuloSAny(arg, bf.args[i]!))) return false
      if (!sTypeEqualsModuloSAny(a.result, bf.result)) return false
      if (a.tpeParams.length !== bf.tpeParams.length) return false
      return a.tpeParams.every((tp, i) => tp.name === bf.tpeParams[i]!.name)
    }
    case 'STypeVar':
      return a.name === (b as { tag: 'STypeVar'; name: string }).name
    // Primitives — tags already match (and neither is SAny, handled above).
    default:
      return true
  }
}
