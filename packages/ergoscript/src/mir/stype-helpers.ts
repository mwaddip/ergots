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
 * Matches sigma-rust's `SType::is_prim` (less `SUnsignedBigInt`, not modeled
 * here).
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
    default:
      // Primitive — only tag matters, and tags already match.
      return true
  }
}
