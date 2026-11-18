/**
 * A collection's class — the facts the JVM's collection object carries beyond
 * its items (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala`).
 *
 * `CollOverArray[@specialized A](toArray, builder)(tA)` (:11) is the array
 * shape: either the plain class or the specialised subclass for one primitive
 * item type. The array has its own runtime class: a primitive array, `Object[]`,
 * or an array of one reference class (`Coll[]`, `Tuple2[]`, …).
 *
 * `PairOfCols[L, R](ls, rs)` (:274) is the pair shape: two collections, one
 * per side of the pair. Each side is again one of these objects.
 */

import type { SType, SValue } from '../mir/types'

/**
 * A typed refusal from the module when `stypeToRType` has no runtime type for
 * the item type handed in: top-level `STypeVar`, `SFunc` of arity other than
 * one or with type parameters, and any `SType` tag the module does not know.
 *
 * Mirrors the JVM's `sys.error` arm of `Evaluation.stypeToRType`
 * (`core/shared/src/main/scala/sigma/Evaluation.scala:54-55` at 6.0.7). The
 * evaluator's facade (`eval/_coll.ts`) wraps this into
 * `EvalError('unsupported-value-type')`; callers outside the evaluator see
 * this typed error directly, with the refused type's tag on the error object.
 */
export class CollTypeRefused extends Error {
  readonly tag: string
  constructor(message: string, tag: string) {
    super(message)
    this.name = 'CollTypeRefused'
    this.tag = tag
  }
}

/** A class tag of the five primitive array kinds (RType.scala's PrimitiveType,
 *  and the five classTag cases Scala specialises arrays on). */
export type PrimitiveArrayClass = 'boolean' | 'byte' | 'short' | 'int' | 'long'

/** A class tag of a reference array kind — `Object[]`, or one of the named
 *  reference classes `stypeToRType` produces class tags for (Evaluation.scala
 *  :17-56, read with RType.scala's PairType/CollType/OptionType/TupleType/FuncType). */
export type ReferenceArrayClass =
  | 'Object'
  | 'Coll'
  | 'Tuple2'
  | 'Option'
  | 'BigInt'
  | 'UnsignedBigInt'
  | 'GroupElement'
  | 'SigmaProp'
  | 'Box'
  | 'AvlTree'
  | 'Header'
  | 'PreHeader'
  | 'String'
  | 'Unit'
  | 'Context'
  | 'Global'
  | 'Function1'

/** The runtime class of a collection's underlying array. */
export type ArrayClass = PrimitiveArrayClass | ReferenceArrayClass

/**
 * The class of a `Coll[A]` object.
 *
 * - `'array'` is a `CollOverArray` (CollsOverArrays.scala:11). `specialised`
 *   says whether this is the specialised subclass for one primitive item type
 *   or the plain class. `array` is the class of the underlying array.
 * - `'pairs'` is a `PairOfCols` (CollsOverArrays.scala:274). Each side has its
 *   own class — again a `CollClass`.
 */
export type CollClass =
  | { shape: 'array'; specialised: boolean; array: ArrayClass }
  | { shape: 'pairs'; ls: CollClass; rs: CollClass }

/** Narrowing of `SValue` to its `Coll` member. */
export type CollValue = Extract<SValue, { kind: 'Coll' }>

/**
 * The class tag `stypeToRType` gives an item type (Evaluation.scala:17-56).
 *
 * The primitive types map to their primitive class tags; `SAny` is
 * `AnyType.classTag = ClassTag.Any`, whose element class is `Object`. A pair
 * type (`STuple` with exactly two items) maps to `PairType.classTag` of
 * `(A, B)`, whose array class is `Tuple2`. A tuple of another arity maps to
 * `TupleType`, whose array class is `Object` as a value (the class tag is
 * `TupleData`), but as an array class under the data reader's tuple arm
 * (`CoreDataSerializer.scala:179-180`) the class tag used is
 * `collRType(AnyType)` — `Coll`. Every `SColl` is `CollType`, whose class tag
 * is `Coll[A]`: array class `Coll`.
 *
 * Throws for a type `stypeToRType` refuses (`_ =>` arm at :53-54): an
 * `STypeVar`, an `SFunc` of another arity than one, a type the reference
 * does not know.
 */
export function arrayClassOf(elem: SType): ArrayClass {
  switch (elem.tag) {
    case 'SBoolean':
      return 'boolean'
    case 'SByte':
      return 'byte'
    case 'SShort':
      return 'short'
    case 'SInt':
      return 'int'
    case 'SLong':
      return 'long'
    case 'SAny':
      return 'Object'
    case 'SUnit':
      return 'Unit'
    case 'SBigInt':
      return 'BigInt'
    case 'SUnsignedBigInt':
      return 'UnsignedBigInt'
    case 'SGroupElement':
      return 'GroupElement'
    case 'SSigmaProp':
      return 'SigmaProp'
    case 'SBox':
      return 'Box'
    case 'SAvlTree':
      return 'AvlTree'
    case 'SHeader':
      return 'Header'
    case 'SPreHeader':
      return 'PreHeader'
    case 'SContext':
      return 'Context'
    case 'SGlobal':
      return 'Global'
    case 'SString':
      return 'String'
    case 'SColl':
      return 'Coll'
    case 'SOption':
      return 'Option'
    case 'STuple':
      return elem.items.length === 2 ? 'Tuple2' : 'Coll'
    case 'SFunc':
      if (elem.args.length === 1 && elem.tpeParams.length === 0) return 'Function1'
      throw new CollTypeRefused(
        `arrayClassOf: stypeToRType refuses SFunc of arity ${elem.args.length}`,
        'SFunc',
      )
    case 'STypeVar':
      throw new CollTypeRefused(
        `arrayClassOf: stypeToRType refuses STypeVar(${elem.name})`,
        'STypeVar',
      )
    default: {
      const exhaustive: never = elem
      throw new CollTypeRefused(
        `arrayClassOf: unhandled SType ${(exhaustive as { tag: string }).tag}`,
        (exhaustive as { tag: string }).tag,
      )
    }
  }
}

/**
 * The class of a value for an array store — the class of the array a
 * specialised receiver casts into (`CollsOverArrays.scala:48-57` and the
 * updated / updateMany / patch readers). Each `SValue` kind has one runtime
 * class, keyed by `kind`: a two-item `Tuple` is `Tuple2`, a `Lambda` is
 * `Function1`, every primitive is its primitive class, and every reference is
 * its reference class name. A `Tuple` of another arity has no single runtime
 * class here — ergots holds such a value as a `Tuple` today, and nothing in
 * this stage stores one into an array — so the function throws for it.
 */
export function runtimeClassOf(v: SValue): ArrayClass {
  switch (v.kind) {
    case 'Boolean':
      return 'boolean'
    case 'Byte':
      return 'byte'
    case 'Short':
      return 'short'
    case 'Int':
      return 'int'
    case 'Long':
      return 'long'
    case 'BigInt':
      return 'BigInt'
    case 'UnsignedBigInt':
      return 'UnsignedBigInt'
    case 'GroupElement':
      return 'GroupElement'
    case 'SigmaProp':
      return 'SigmaProp'
    case 'Box':
      return 'Box'
    case 'PreHeader':
      return 'PreHeader'
    case 'Header':
      return 'Header'
    case 'AvlTree':
      return 'AvlTree'
    case 'Unit':
      return 'Unit'
    case 'Context':
      return 'Context'
    case 'Global':
      return 'Global'
    case 'Coll':
      return 'Coll'
    case 'Option':
      return 'Option'
    case 'Lambda':
      return 'Function1'
    case 'String':
      return 'String'
    case 'Tuple':
      if (v.items.length === 2) return 'Tuple2'
      throw new Error(`runtimeClassOf: Tuple of arity ${v.items.length} has no runtime class here`)
    default: {
      const exhaustive: never = v
      throw new Error(`runtimeClassOf: unhandled SValue kind ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

/**
 * The class the data reader (`CoreDataSerializer.deserializeColl`, :166-191)
 * gives a collection for `elem`:
 *
 * - `SBoolean` (:172) and `SByte` (:174): specialised, over the primitive
 *   array.
 * - A pair item type: `PairOfCols` with plain sides over the two class tags
 *   (`fromBoxedPairs`, :205-215, via `pairCollFromArrays`, which calls
 *   `fromArray` under the erased pair sides — so each side is the plain class
 *   over that side's class tag).
 * - A tuple of another arity: the data reader goes through
 *   `Colls.fromArray(arr)(sigma.AnyType)` on the tuple arm (:139-143) and the
 *   else branch of `deserializeColl` uses `collRType(AnyType)` as the item
 *   descriptor (:179-180) when the element type is an `STuple` of another
 *   arity — array class `Coll`.
 * - Every other item type (:176-190): the plain class over an array of the
 *   item type's class tag.
 */
export function dataClass(elem: SType): CollClass {
  if (elem.tag === 'SBoolean' || elem.tag === 'SByte') {
    return { shape: 'array', specialised: true, array: arrayClassOf(elem) }
  }
  if (elem.tag === 'STuple' && elem.items.length === 2) {
    const [a, b] = elem.items as [SType, SType]
    return { shape: 'pairs', ls: dataClassSide(a), rs: dataClassSide(b) }
  }
  return { shape: 'array', specialised: false, array: arrayClassOf(elem) }
}

/**
 * A side of a `PairOfCols` built by `pairCollFromArrays` (:205-215) is always
 * plain (its `fromArray` is called with the erased type, so the specialisation
 * annotation does not apply), with the side's class tag as the array class.
 * A side whose type is itself a pair is `'pairs'` again (recursive).
 */
function dataClassSide(elem: SType): CollClass {
  if (elem.tag === 'STuple' && elem.items.length === 2) {
    const [a, b] = elem.items as [SType, SType]
    return { shape: 'pairs', ls: dataClassSide(a), rs: dataClassSide(b) }
  }
  return { shape: 'array', specialised: false, array: arrayClassOf(elem) }
}

/** `v.cls`, or `dataClass(v.elem)` when absent. A value a reader or a
 *  public-API caller hands in without `cls` is read with the data reader's
 *  rule; every value built inside `packages/*\/src` has `cls` set. */
export function classOf(v: CollValue): CollClass {
  return v.cls ?? dataClass(v.elem)
}
