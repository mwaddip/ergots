/**
 * Builders for a `Coll` value — one per JVM entry point, named after it.
 *
 * JVM references at 6.0.7:
 *   core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:226-233
 *                                             CollOverArrayBuilder.fromArray
 *   core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:205-215
 *                                             fromBoxedPairs (pair routing)
 *   core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:11, :323
 *                                             new CollOverArray (no routing)
 */

import type { SType, SValue } from '../mir/types'
import {
  arrayClassOf,
  CollArrayStore,
  CollClassCast,
  dataClass,
  runtimeClassOf,
  type ArrayClass,
  type CollClass,
  type CollValue,
} from './class'

/**
 * `CollOverArrayBuilder.fromArray` (:226-233). A pair item type routes to
 * `fromBoxedPairs` (:205-215), whose sides are the plain class over the side
 * type's array, or pairs again for a side of a pair type, whatever
 * `specialised` says (`boxedPairsClass` below). The pair routing stores each
 * pair component into `Array.ofDim[A](len)(tA.classTag)` and `Array.ofDim[B]
 * (len)(tB.classTag)` through direct aastore — a component whose class is
 * not the side's class throws (SANTA `Coll.reference_store_ops` #33
 * `map-pair-component-lie-errored`: a pair whose right component is a
 * `GroupElement` into `Array[Box]` throws; #35 `pair-map-lie-reverse-errored`:
 * the lie reaches the typed side when `reverse` rebuilds through this
 * routing).
 *
 * Otherwise `new CollOverArray(arr, builder)` with the type's class tag:
 * specialised for a primitive item type iff `specialised` is set (the
 * `@specialized` annotation of `fromArray`'s T decides this at the call
 * site, and the JVM's callers pass the concrete type or an erased type to
 * pick one), plain for a reference item type whatever `specialised` says.
 */
export function fromArray(elem: SType, items: SValue[], specialised: boolean): CollValue {
  if (elem.tag === 'STuple' && elem.items.length === 2) {
    const [a, b] = elem.items as [SType, SType]
    return { kind: 'Coll', elem, items, cls: boxedPairsClass(a, b, items) }
  }
  const array = arrayClassOf(elem)
  return {
    kind: 'Coll',
    elem,
    items,
    cls: { shape: 'array', specialised: specialised && isPrimitive(elem), array },
  }
}

/**
 * The class `fromBoxedPairs` gives a collection of pairs
 * (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:205-215`),
 * with the stores it makes on the way.
 *
 * Each pair's two components are stored into two arrays of the sides' class
 * tags (`:207-212`): a component whose class is not its side's is refused.
 * Then `pairCollFromArrays(resA, resB)` (`:214`) builds each side with
 * `fromArray` at the side's type, the left side before the right: a side of
 * a pair type is built by `fromBoxedPairs` again from that side's components
 * (`:226-230`), and any other side is the plain class over its array
 * (`:231-232`; the call is made at an abstract type, so nothing is
 * specialised).
 */
function boxedPairsClass(a: SType, b: SType, pairs: SValue[]): CollClass {
  const lsArray = arrayClassOf(a)
  const rsArray = arrayClassOf(b)
  const lsItems: SValue[] = new Array(pairs.length)
  const rsItems: SValue[] = new Array(pairs.length)
  for (let i = 0; i < pairs.length; i++) {
    const item = pairs[i]!
    if (item.kind !== 'Tuple' || item.items.length !== 2) {
      throw new CollArrayStore(
        `Array[Tuple2].store: item of kind ${item.kind} is no pair`,
      )
    }
    lsItems[i] = item.items[0]!
    rsItems[i] = item.items[1]!
    storeComponent(lsArray, lsItems[i]!)
    storeComponent(rsArray, rsItems[i]!)
  }
  const ls = sideClass(a, lsArray, lsItems)
  const rs = sideClass(b, rsArray, rsItems)
  return { shape: 'pairs', ls, rs }
}

/** `fromArray` of one side's array at the side's type, as `pairCollFromArrays` calls it. */
function sideClass(sideElem: SType, sideArray: ArrayClass, sideItems: SValue[]): CollClass {
  if (sideElem.tag === 'STuple' && sideElem.items.length === 2) {
    const [a, b] = sideElem.items as [SType, SType]
    return boxedPairsClass(a, b, sideItems)
  }
  return { shape: 'array', specialised: false, array: sideArray }
}

/**
 * Store one item into an array of class `array`, by the JVM's aastore rule:
 * a primitive array unboxes (`BoxesRunTime.unboxTo<T>` → `ClassCastException`,
 * mirrored by `CollClassCast`); a reference array of `'Object'` takes
 * anything; `'Coll'` takes any collection; another named reference class
 * refuses an item of another class (`ArrayStoreException`, mirrored by
 * `CollArrayStore`).
 *
 * This is the one helper the pair builder's component check calls
 * (`CollsOverArrays.scala:205-215` through `Array.ofDim[A](len)(tA.classTag)`
 * and the aastore that follows), the `unzip` fallback (`:245-259`), and the
 * per-item store of `patch` / `updated` / `updateMany` / `append` on a
 * plain receiver.
 *
 * `'Unit'` has three paths in scala-library 2.12.20: `'drop-unit'` (the
 * `ArrayBuilder.ofUnit.++=` path used by `Array.patch` on a `Unit` elem and
 * by `Array.flatMap`'s per-part `++=`: counts items and fills with units,
 * dropping the stored value), `'astore'` (a direct `res(i) = elem` into
 * `new Array[Unit] = BoxedUnit[]`: an aastore check, `CollArrayStore`), and
 * `'builder-cast'` (`ArrayBuilder.ofUnit.+=(Unit)`, where the call site
 * inserts an unbox cast to `BoxedUnit`: `CollClassCast`). The primitive
 * and reference paths match across modes.
 *
 * Returns the stored value: the item unchanged, or a `{ kind: 'Unit' }`
 * when `mode === 'drop-unit'` and the array is `'Unit'`.
 */
export type StoreMode = 'drop-unit' | 'astore' | 'builder-cast'

export function storeIntoArray(array: ArrayClass, item: SValue, mode: StoreMode): SValue {
  if (array === 'Unit' && mode === 'drop-unit') return { kind: 'Unit' }
  if (array === 'Object') return item
  const itemClass = runtimeClassOf(item)
  if (array === 'Unit') {
    if (itemClass !== 'Unit') {
      if (mode === 'builder-cast') {
        throw new CollClassCast(
          `Array[Unit].store: item of class ${itemClass} fails unbox-cast to BoxedUnit (ArrayBuilder.ofUnit.+=)`,
        )
      }
      throw new CollArrayStore(
        `Array[Unit].store: item of class ${itemClass} is not Unit`,
      )
    }
    return item
  }
  if (array === 'Coll') {
    if (itemClass !== 'Coll') {
      throw new CollArrayStore(
        `Array[Coll].store: item of class ${itemClass} is not a Coll`,
      )
    }
    return item
  }
  if (array === 'boolean' || array === 'byte' || array === 'short' || array === 'int' || array === 'long') {
    if (itemClass !== array) {
      throw new CollClassCast(
        `Array[${array}].store: item of class ${itemClass} fails unbox to ${array}`,
      )
    }
    return item
  }
  if (itemClass !== array) {
    throw new CollArrayStore(
      `Array[${array}].store: item of class ${itemClass} is not ${array}`,
    )
  }
  return item
}

/**
 * `storeIntoArray` on an entire collection's class: a specialised side's
 * array runs the primitive unbox; a plain side's runs the aastore; a pairs
 * side's checks the item is a pair; an unknown side has no named array and
 * reaching here is a module-internal contract violation.
 */
export function storeIntoClass(cls: CollClass, item: SValue, mode: StoreMode = 'astore'): SValue {
  if (cls.shape === 'pairs') {
    if (item.kind !== 'Tuple' || item.items.length !== 2) {
      throw new CollClassCast(
        `Array[Tuple2].store: item of kind ${item.kind} is no pair`,
      )
    }
    return item
  }
  if (cls.shape === 'unknown') {
    throw new CollClassCast(
      `Array[unknown].store: an unknown-class side has no named array`,
    )
  }
  return storeIntoArray(cls.array, item, mode)
}

/**
 * Store one pair component into its side's typed array, by the JVM's
 * aastore rule. The pair builder's component check (`CollsOverArrays.scala`
 * `:209-212`) and the `unzip` fallback (`:245-259`) both call it; the
 * `'astore'` mode is the direct store, as scala-library's aastore does.
 */
function storeComponent(array: ArrayClass, item: SValue): void {
  storeIntoArray(array, item, 'astore')
}

/**
 * `new CollOverArray(arr, builder)` with no pair routing (:323): always the
 * plain class, over the element type's class tag. Used wherever the JVM
 * builds a `CollOverArray` directly, bypassing `CollOverArrayBuilder` — such
 * as `PairOfCols.map` (:322), which drops the pair shape.
 */
export function collOverArray(elem: SType, items: SValue[]): CollValue {
  return {
    kind: 'Coll',
    elem,
    items,
    cls: { shape: 'array', specialised: false, array: arrayClassOf(elem) },
  }
}

/**
 * `Colls.fromArray(Array[Byte])` (specialised) or the same bytes seen as a
 * plain byte collection (`Array[Byte].toColl`). Sign-extends each byte: the
 * JVM's `Byte` is signed, so a wire `0xFF` reads as `-1`.
 */
export function byteColl(bytes: Uint8Array, specialised: boolean): CollValue {
  const items: SValue[] = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    items[i] = { kind: 'Byte', value: (b << 24) >> 24 }
  }
  return {
    kind: 'Coll',
    elem: { tag: 'SByte' },
    items,
    cls: { shape: 'array', specialised, array: 'byte' },
  }
}

/**
 * The collection `CoreDataSerializer.deserializeColl` builds
 * (`core/shared/src/main/scala/sigma/data/CoreDataSerializer.scala:166-191`):
 * its class is `dataClass(elem)`. The data reader specialises for `SBoolean`
 * (:172) and `SByte` (:174), routes a pair element type to `pairCollFromArrays`
 * (:205-215), and goes through `new CollOverArray` (:176-190) for every other
 * item type.
 */
export function fromData(elem: SType, items: SValue[]): CollValue {
  return { kind: 'Coll', elem, items, cls: dataClass(elem) }
}

/**
 * A `Coll` with exactly this class. For the module's operations only: not
 * re-exported from `coll/index.ts`. The caller takes responsibility for
 * matching `cls` with `elem` and `items`.
 */
export function withClass(elem: SType, items: SValue[], cls: CollClass): CollValue {
  return { kind: 'Coll', elem, items, cls }
}

/**
 * The one builder of the `'unknown'` class. An empty collection whose array
 * ergots cannot name: a `map` / `flatMap` result of a mapper whose static
 * range ergots types as `SAny`, with an empty input. The result's `elem`
 * stands in as the mapper's static range (usually `SAny`), and the items
 * array is empty: a non-empty collection never carries this class, since
 * every operation that puts an item into a collection of unknown class
 * routes through a builder that reads the item's own class.
 *
 * The JVM has the real range type at the call, and gives the collection its
 * array (`methods.scala:1005-1007` `flatMap_eval` at `mc.tpe`'s element
 * type; `transformers.scala:43-45` `MapCollection.eval` at `mapper.tpe.tRange`);
 * every reader by class then answers. ergots does not have it, so the class
 * is a marker every reader handles by the rule an empty collection of the
 * receiver's own class gives.
 */
export function empty(elem: SType): CollValue {
  return { kind: 'Coll', elem, items: [], cls: { shape: 'unknown' } }
}

/** Alias of `empty` under a descriptive name for tests and documents. */
export const emptyOfUnknownClass = empty

function isPrimitive(elem: SType): boolean {
  switch (elem.tag) {
    case 'SBoolean':
    case 'SByte':
    case 'SShort':
    case 'SInt':
    case 'SLong':
      return true
    default:
      return false
  }
}
