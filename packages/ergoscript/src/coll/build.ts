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
 * type's array, whatever `specialised` says. The pair routing stores each
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
    const lsArray = arrayClassOf(a)
    const rsArray = arrayClassOf(b)
    // `fromBoxedPairs` stores each component into its side's typed array;
    // the component's class is checked per the side's class rule.
    for (const item of items) {
      if (item.kind !== 'Tuple' || item.items.length !== 2) {
        throw new CollArrayStore(
          `Array[Tuple2].store: item of kind ${item.kind} is no pair`,
        )
      }
      storeComponent(lsArray, item.items[0]!)
      storeComponent(rsArray, item.items[1]!)
    }
    return {
      kind: 'Coll',
      elem,
      items,
      cls: {
        shape: 'pairs',
        ls: { shape: 'array', specialised: false, array: lsArray },
        rs: { shape: 'array', specialised: false, array: rsArray },
      },
    }
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
 * Store one pair component into its side's typed array, by the same rules as
 * `storeOne('astore')` in `ops.ts`: a primitive side unboxes (`CollClassCast`
 * on a mismatched class); a reference side runs the aastore component check
 * (`CollArrayStore`).
 */
function storeComponent(array: ArrayClass, item: SValue): void {
  if (array === 'Object') return
  const itemClass = runtimeClassOf(item)
  if (array === 'Coll') {
    if (itemClass !== 'Coll') {
      throw new CollArrayStore(
        `Array[Coll].store: item of class ${itemClass} is not a Coll`,
      )
    }
    return
  }
  if (array === 'boolean' || array === 'byte' || array === 'short' || array === 'int' || array === 'long') {
    if (itemClass !== array) {
      throw new CollClassCast(
        `Array[${array}].store: item of class ${itemClass} fails unbox to ${array}`,
      )
    }
    return
  }
  if (itemClass !== array) {
    throw new CollArrayStore(
      `Array[${array}].store: item of class ${itemClass} is not ${array}`,
    )
  }
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
