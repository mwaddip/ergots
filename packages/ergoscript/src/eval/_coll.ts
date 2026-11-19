/**
 * The evaluator's facade over `src/coll/`. Every evaluator arm, handler or
 * helper that calls into the collection module goes through this file: a
 * single site turns the module's typed refusals into the evaluator's
 * `EvalError` codes, and every other error passes through untouched.
 *
 * The typed refusals the module raises:
 *   - `CollTypeRefused` → `EvalError('unsupported-value-type')`. What
 *     `arrayClassOf` throws when `stypeToRType` has no runtime type for the
 *     item type (`core/shared/src/main/scala/sigma/Evaluation.scala:54-55`
 *     at 6.0.7, the `case _ => sys.error` arm). The JVM throws through the
 *     same path at every call site that reads a collection's class tag,
 *     such as `ConcreteCollection.eval` (`values.scala:890`) and
 *     `MapCollection.eval` (`transformers.scala:43`).
 *   - `CollClassCast` → `EvalError('coll-class-cast')`. The JVM's
 *     `ClassCastException` on a specialised receiver's default unbox
 *     (`CollsOverArrays.scala:26`) and on a pairs receiver's bridge-method
 *     cast of `default: Object` to `Tuple2` at the `getOrElse` call
 *     (`CollsOverArrays.scala:309-315`).
 *   - `CollArrayStore` → `EvalError('coll-array-store')`. The JVM's
 *     `ArrayStoreException` from an array store a collection operation
 *     refuses (`CollsOverArrays.scala:48-57` and the updated / updateMany /
 *     patch readers).
 *
 * This facade keeps the evaluator-to-module boundary free of plain `Error`s.
 */

import type { SType, SValue } from '../mir/types'
import {
  append as _append,
  byteColl as _byteColl,
  castArray as _castArray,
  classOf as _classOf,
  collOverArray as _collOverArray,
  empty as _empty,
  endsWith as _endsWith,
  filtered as _filtered,
  flatMapped as _flatMapped,
  fromArray as _fromArray,
  fromData as _fromData,
  getOrElse as _getOrElse,
  indices as _indices,
  mapped as _mapped,
  patch as _patch,
  reversed as _reversed,
  slice as _slice,
  startsWith as _startsWith,
  tupleColl as _tupleColl,
  updateMany as _updateMany,
  updated as _updated,
  zip as _zip,
  CollArrayStore,
  CollClassCast,
  CollTypeRefused,
  type ArrayClass as _ArrayClass,
  type CollClass as _CollClass,
  type CollValue as _CollValue,
} from '../coll'
import { EvalError } from './eval-context'

export type CollClass = _CollClass
export type CollValue = _CollValue

/**
 * Run `fn` and translate the collection module's three typed refusals into
 * their `EvalError` codes: `CollTypeRefused` →
 * `EvalError('unsupported-value-type')`, `CollClassCast` →
 * `EvalError('coll-class-cast')`, `CollArrayStore` →
 * `EvalError('coll-array-store')`. Every other error passes through.
 */
function guard<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof CollTypeRefused) {
      throw new EvalError(err.message, 'unsupported-value-type')
    }
    if (err instanceof CollClassCast) {
      throw new EvalError(err.message, 'coll-class-cast')
    }
    if (err instanceof CollArrayStore) {
      throw new EvalError(err.message, 'coll-array-store')
    }
    throw err
  }
}

/** The data reader's class for a value handed in without `cls`. */
export function classOf(v: CollValue): CollClass {
  return guard(() => _classOf(v))
}

/** `CollOverArrayBuilder.fromArray` (`CollsOverArrays.scala:226-233`). */
export function fromArray(elem: SType, items: SValue[], specialised: boolean): CollValue {
  return guard(() => _fromArray(elem, items, specialised))
}

/** `new CollOverArray` (`CollsOverArrays.scala:11`, `:323`), no pair routing. */
export function collOverArray(elem: SType, items: SValue[]): CollValue {
  return guard(() => _collOverArray(elem, items))
}

/** `Colls.fromArray(Array[Byte])` / `Array[Byte].toColl`. */
export function byteColl(bytes: Uint8Array, specialised: boolean): CollValue {
  return _byteColl(bytes, specialised)
}

/** An empty collection of the unknown class (`coll/build.ts` `empty`). Used
 *  by the `map` and `flatMap` arms where the mapper's static range ergots
 *  types as `SAny` and the output is empty: the JVM has the real range at
 *  that call and gives the collection its array; ergots does not, and every
 *  reader by class takes the unknown class by the empty-receiver-of-its-own-
 *  class rule. */
export function empty(elem: SType): CollValue {
  return _empty(elem)
}

/** The collection the data reader builds (`CoreDataSerializer.deserializeColl` :166-191). */
export function fromData(elem: SType, items: SValue[]): CollValue {
  return guard(() => _fromData(elem, items))
}

/** `Coll.slice` (`CollsOverArrays.scala:40`, `:377`). */
export function slice(c: CollValue, from: number, until: number): CollValue {
  return guard(() => _slice(c, from, until))
}

/** `Coll.filter` (`CollsOverArrays.scala:36`, `:348-363`). */
export function filtered(c: CollValue, kept: SValue[]): CollValue {
  return guard(() => _filtered(c, kept))
}

/** `Coll.map` (`CollsOverArrays.scala:28`, `:317-324`). */
export function mapped(c: CollValue, tRange: SType, items: SValue[]): CollValue {
  return guard(() => _mapped(c, tRange, items))
}

/** `Coll.flatMap` (`CollsOverArrays.scala:70`, `:410`). Each per-element body
 *  result is one PART of `parts`; the module reads each part's length and
 *  class to apply the JVM's `ArrayBuilder.++=` rule. */
export function flatMapped(c: CollValue, tRange: SType, parts: CollValue[]): CollValue {
  return guard(() => _flatMapped(c, tRange, parts))
}

/** `Coll.reverse` (`CollsOverArrays.scala:59`, `:384-394`). */
export function reversed(c: CollValue): CollValue {
  return guard(() => _reversed(c))
}

/** `Coll.indices` (`CollsOverArrays.scala:68`, `:408`). */
export function indices(c: CollValue): CollValue {
  return guard(() => _indices(c))
}

/** `Coll.zip` (`CollsOverArrays.scala:42`, `:396`). */
export function zip(c: CollValue, ys: CollValue): CollValue {
  return guard(() => _zip(c, ys))
}

/** `Coll.getOrElse` (`CollsOverArrays.scala:26`, `:309-315`). */
export function getOrElse(c: CollValue, i: number, d: SValue): SValue {
  return guard(() => _getOrElse(c, i, d))
}

/** `Coll.patch` (`CollsOverArrays.scala:94-98`, `:423-428`). */
export function patch(
  c: CollValue,
  from: number,
  p: CollValue,
  replaced: number,
): CollValue {
  return guard(() => _patch(c, from, p, replaced))
}

/** `Coll.startsWith` (`CollsOverArrays.scala:44`, `:398-401`). */
export function startsWith(
  c: CollValue,
  ys: CollValue,
  itemEq: (a: SValue, b: SValue) => boolean,
): boolean {
  return guard(() => _startsWith(c, ys, itemEq))
}

/** `Coll.endsWith` (`CollsOverArrays.scala:46`, `:403-406`). */
export function endsWith(
  c: CollValue,
  ys: CollValue,
  itemEq: (a: SValue, b: SValue) => boolean,
): boolean {
  return guard(() => _endsWith(c, ys, itemEq))
}

/** `Coll.updated` (`CollsOverArrays.scala:100-104`, `:430-434`). */
export function updated(c: CollValue, index: number, item: SValue): CollValue {
  return guard(() => _updated(c, index, item))
}

/** `Coll.updateMany` (`CollsOverArrays.scala:106-117`, `:436-450`). */
export function updateMany(
  c: CollValue,
  indexes: number[],
  values: CollValue,
): CollValue {
  return guard(() => _updateMany(c, indexes, values))
}

/** `Coll.append` (`CollsOverArrays.scala:48-57`, `:379-382`). */
export function append(c: CollValue, other: CollValue): CollValue {
  return guard(() => _append(c, other))
}

/** The value of a tuple of another arity than two,
 *  `Colls.fromArray(arr)(sigma.AnyType)` (`CoreDataSerializer.scala:139-143`,
 *  `values.scala:818-822`). */
export function tupleColl(items: SValue[]): CollValue {
  return _tupleColl(items)
}

/** The cast a consumer makes when it needs the array of a class
 *  (`toArray.asInstanceOf[Array[T]]`, `coll/ops.ts` `castArray`). */
export function castArray(c: CollValue, array: _ArrayClass, what: string): SValue[] {
  return guard(() => _castArray(c, array, what))
}

/**
 * The guard as a standalone export, so a test can exercise the translation
 * directly without reaching through one of the wrapped functions.
 */
export const translateCollTypeRefused = guard
