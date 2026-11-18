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
import { arrayClassOf, dataClass, type CollClass, type CollValue } from './class'

/**
 * `CollOverArrayBuilder.fromArray` (:226-233). A pair item type routes to
 * `fromBoxedPairs` (:205-215), whose sides are the plain class over the side
 * type's array, whatever `specialised` says. Otherwise `new CollOverArray(arr,
 * builder)` with the type's class tag: specialised for a primitive item type
 * iff `specialised` is set (the `@specialized` annotation of `fromArray`'s T
 * decides this at the call site, and the JVM's callers pass the concrete type
 * or an erased type to pick one), plain for a reference item type whatever
 * `specialised` says.
 */
export function fromArray(elem: SType, items: SValue[], specialised: boolean): CollValue {
  if (elem.tag === 'STuple' && elem.items.length === 2) {
    const [a, b] = elem.items as [SType, SType]
    return {
      kind: 'Coll',
      elem,
      items,
      cls: {
        shape: 'pairs',
        ls: { shape: 'array', specialised: false, array: arrayClassOf(a) },
        rs: { shape: 'array', specialised: false, array: arrayClassOf(b) },
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
