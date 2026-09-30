/**
 * The JVM's type equality and numeric tests (sigma-state 6.0.6), for the checks ergots makes where
 * the JVM builds or substitutes a node (spec docs/specs/2026-09-30-jvm-node-construction-design.md
 * §2; facts/ergoscript-wire.md, "Node construction").
 *
 * The JVM compares types with Scala `==`: structurally for its case classes (`SCollectionType`,
 * `SOption`, `STuple`, `SFunc`, `STypeVar`) and by identity for its case objects, so its `NoType`
 * never equals its `SAny` (core/.../sigma/ast/SType.scala:278, 626). ergots models those two as the
 * frozen objects `SANY_JVM` and `NOTYPE_JVM` (mir/types.ts). Any other `{ tag: 'SAny' }` is ergots'
 * own: a type its method typing could not resolve, whose JVM type is unknown (residual 1).
 */

import type { SType } from './types'
import { NOTYPE_JVM, SANY_JVM } from './types'

/** An `SAny` that is neither the JVM's `SAny` nor its `NoType`: ergots' own unresolved type (residual 1). */
export function isOwnSAny(t: SType): boolean {
  return t.tag === 'SAny' && t !== SANY_JVM && t !== NOTYPE_JVM
}

/**
 * The JVM's `SNumericType` order, `numericTypeIndex` (core/.../sigma/ast/SType.scala:412-556):
 * Byte 0, Short 1, Int 2, Long 3, BigInt 4, UnsignedBigInt 5.
 */
const NUMERIC_TYPE_INDEX: ReadonlyMap<SType['tag'], number> = new Map<SType['tag'], number>([
  ['SByte', 0],
  ['SShort', 1],
  ['SInt', 2],
  ['SLong', 3],
  ['SBigInt', 4],
  ['SUnsignedBigInt', 5],
])

/** `tpe.isInstanceOf[SNumericType]` (`isNumType`, core/.../sigma/ast/package.scala:133). */
export function isJvmNumeric(t: SType): boolean {
  return NUMERIC_TYPE_INDEX.has(t.tag)
}

/**
 * A numeric type's `numericTypeIndex`, 0–5. The JVM defines it on numeric types only; for any other
 * type this throws, a caller's bug (check `isJvmNumeric` first).
 */
export function numericTypeIndex(t: SType): number {
  const index = NUMERIC_TYPE_INDEX.get(t.tag)
  if (index === undefined) {
    throw new Error(`numericTypeIndex: ${t.tag} is not a numeric type`)
  }
  return index
}

type Verdict = boolean | 'unknown'
/** Decides a pair of types outright, or returns `undefined` to compare them structurally. */
type LeafRule = (a: SType, b: SType) => Verdict | undefined

/** Kleene conjunction over pairs: `false` if any pair is unequal, else `'unknown'` if any is unknown, else `true`. */
function allPairs(as: readonly SType[], bs: readonly SType[], leaf: LeafRule): Verdict {
  if (as.length !== bs.length) return false
  let verdict: Verdict = true
  for (let i = 0; i < as.length; i++) {
    const v = compare(as[i]!, bs[i]!, leaf)
    if (v === false) return false
    if (v === 'unknown') verdict = 'unknown'
  }
  return verdict
}

/** Structural type comparison, as `sTypeEquals` (mir/stype-helpers.ts), under a leaf rule. */
function compare(a: SType, b: SType, leaf: LeafRule): Verdict {
  const decided = leaf(a, b)
  if (decided !== undefined) return decided
  if (a.tag !== b.tag) return false
  switch (a.tag) {
    case 'SColl':
    case 'SOption':
      return compare(a.elem, (b as { elem: SType }).elem, leaf)
    case 'STuple':
      return allPairs(a.items, (b as { items: SType[] }).items, leaf)
    case 'SFunc': {
      const bf = b as Extract<SType, { tag: 'SFunc' }>
      // SFunc(tDom, tRange, tpeParams) is a case class (SType.scala:660): all three fields compare.
      if (a.tpeParams.length !== bf.tpeParams.length) return false
      if (!a.tpeParams.every((p, i) => p.name === bf.tpeParams[i]!.name)) return false
      return allPairs([...a.args, a.result], [...bf.args, bf.result], leaf)
    }
    case 'STypeVar':
      return a.name === (b as { name: string }).name
    case 'SBoolean':
    case 'SByte':
    case 'SShort':
    case 'SInt':
    case 'SLong':
    case 'SBigInt':
    case 'SUnsignedBigInt':
    case 'SGroupElement':
    case 'SSigmaProp':
    case 'SBox':
    case 'SAvlTree':
    case 'SUnit':
    case 'SAny':
    case 'SHeader':
    case 'SPreHeader':
    case 'SContext':
    case 'SGlobal':
    case 'SString':
      return true
    default: {
      const unknownTag: never = a
      return unknownTag
    }
  }
}

/** ergots' own SAny is unknown; the JVM's `SAny` and `NoType` each equal only themselves. */
const jvmLeaf: LeafRule = (a, b) => {
  if (isOwnSAny(a) || isOwnSAny(b)) return 'unknown'
  if (a === SANY_JVM || a === NOTYPE_JVM || b === SANY_JVM || b === NOTYPE_JVM) return a === b
  return undefined
}

/**
 * The JVM's `==` on types, for the parse-time checks only (`check2`'s `SameType`,
 * SigmaBuilder.scala:286-295; the collection item assert, ConcreteCollectionSerializer.scala:35-39).
 * Structural, as `sTypeEquals` is, except that a `NOTYPE_JVM` or `SANY_JVM` leaf equals only the same
 * object, and ergots' own `SAny` makes a leaf `'unknown'` (residual 1), which every check passes. A
 * known difference elsewhere in the same type still makes the result `false`.
 */
export function jvmTypeEquals(a: SType, b: SType): Verdict {
  return compare(a, b, jvmLeaf)
}

/** The JVM's `NoType` equals only itself; every other leaf compares as `sTypeEquals` does. */
const scriptLeaf: LeafRule = (a, b) => (a === NOTYPE_JVM || b === NOTYPE_JVM ? a === b : undefined)

/**
 * The substitution's comparison of a decoded script's type with the declared one
 * (`CheckDeserializedScriptType`, org/ergoplatform/validation/ValidationRules.scala:24-37, a `!=`):
 * `sTypeEquals`, except that a `NOTYPE_JVM` leaf, at any depth, equals only `NOTYPE_JVM`, the JVM's
 * `NoType != SAny`. ergots' own `SAny` still equals any `SAny` and nothing else, as under
 * `sTypeEquals` (residual 1).
 */
export function scriptTypeEquals(a: SType, b: SType): boolean {
  return compare(a, b, scriptLeaf) === true
}
