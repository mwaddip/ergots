/**
 * The collection operations whose result class depends on the receiver's
 * class and on which JVM builder the operation calls.
 *
 * Each function mirrors the body of a JVM method in both shapes at 6.0.7:
 *   core/shared/src/main/scala/sigma/data/CollsOverArrays.scala
 *     CollOverArray         :11-157   (@specialized A — slice/filter/reverse
 *                                       stay specialised, carry pair routing)
 *     CollOverArrayBuilder :180-272
 *     PairOfCols           :274-486
 *   core/shared/src/main/scala/sigma/Colls.scala:349   pairCollFromArrays
 *
 * Builder calls and what they decide about the result's class:
 *   - `builder.fromArray(arr)` reached inside the `@specialized` class
 *     CollOverArray[A] (slice, filter, reverse) keeps the receiver's object
 *     class — specialised stays specialised, plain stays plain — AND routes a
 *     pair item type through fromBoxedPairs (:205-215, :226-233) to a
 *     PairOfCols with plain sides.
 *   - `new CollOverArray(res, builder)` written out (PairOfCols.map :322) is
 *     always plain and never routes pairs.
 *   - `builder.pairColl(as, bs)` (:183-203) keeps each side as handed, after
 *     cutting the longer one with `slice` when the lengths differ.
 *   - `builder.pairCollFromArrays(as, bs)` (Colls.scala :349)
 *       = pairColl(fromArray(as), fromArray(bs))
 *     under the two side types as abstract A/B, so each side comes out plain.
 *   - `builder.fromArray` called from a method that is not specialised on the
 *     result's type (map[B], flatMap[B], PairOfCols.filter) runs at abstract
 *     B, so the result is plain; pair routing still fires on a pair B.
 */

import type { SType, SValue } from '../mir/types'
import { arrayClassOf, classOf, CollArrayStore, CollClassCast, runtimeClassOf, type ArrayClass, type CollClass, type CollValue } from './class'
import { collOverArray, fromArray, withClass } from './build'

/**
 * `CollOverArray.slice(from, until)` (:40):
 *     builder.fromArray(toArray.slice(from, until))
 * The specialised receiver stays specialised; a plain one stays plain. A pair
 * item type on an array-shape receiver routes to pairs with plain sides.
 *
 * `PairOfCols.slice` (:377):
 *     builder.pairColl(ls.slice(from, until), rs.slice(from, until))
 * Each side goes through its own slice, then `pairColl` makes the new pair,
 * keeping each side's class.
 *
 * Scala's `Array.slice(from, until)`: negative `from` clamps to 0; `until`
 * past the length clamps to the length; `until <= from` gives an empty array.
 */
export function slice(c: CollValue, from: number, until: number): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'pairs') {
    const { ls, rs } = splitSides(c, cls)
    return pairColl(slice(ls, from, until), slice(rs, from, until))
  }
  const len = c.items.length
  const lo = Math.max(0, from)
  const hi = Math.min(len, until)
  const items = lo >= hi ? [] : c.items.slice(lo, hi)
  return fromArray(c.elem, items, cls.specialised)
}

/**
 * `CollOverArray.filter(p)` (:36):
 *     builder.fromArray(toArray.filter(p))
 * Same rule as `slice`: specialisation preserved; a pair item type on an
 * array-shape receiver would route to pairs with plain sides (not reachable
 * inside the specialised subclass, whose A is primitive).
 *
 * `PairOfCols.filter(p)` (:348-363):
 *     builder.pairCollFromArrays(resL.toArray(), resR.toArray())
 *   = pairColl(fromArray(resL), fromArray(resR))
 * at the two side types as abstract A/B — each side comes out plain, whatever
 * the receiver's side class was.
 *
 * The caller (an evaluator arm) applies the predicate and passes the items it
 * kept.
 */
export function filtered(c: CollValue, kept: SValue[]): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'pairs') {
    const { ls: lsElem, rs: rsElem } = sideElems(c)
    const [lsItems, rsItems] = splitPairItems(kept)
    return pairColl(fromArray(lsElem, lsItems, false), fromArray(rsElem, rsItems, false))
  }
  return fromArray(c.elem, kept, cls.specialised)
}

/**
 * `CollOverArray.map[B](f)` (:28-31):
 *     builder.fromArray(toArray.map(f))
 * `B` is abstract at the interpreter's call site, so the specialised variant
 * of `fromArray` is not picked — the result is plain. A pair `tRange` still
 * routes to pairs with plain sides.
 *
 * `PairOfCols.map[V](f)` (:317-324):
 *     new CollOverArray(res, builder)
 * Always plain, no pair routing: a pair `tRange` on a pairs receiver gives a
 * plain array of Tuple2.
 *
 * The caller (an evaluator arm) applies the lambda and passes the mapped
 * items at `tRange`.
 */
export function mapped(c: CollValue, tRange: SType, items: SValue[]): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'pairs') {
    return collOverArray(tRange, items)
  }
  return fromArray(tRange, items, false)
}

/**
 * `CollOverArray.flatMap[B](f)` (:70-73):
 *     builder.fromArray(toArray.flatMap(x => f(x).toArray))
 * `B` is abstract — plain; a pair `tRange` still routes to pairs with plain
 * sides.
 *
 * `PairOfCols.flatMap[B](f)` (:410-411):
 *     builder.fromArray(toArray.flatMap(p => f(p).toArray))
 * Same rule — both shapes go through `fromArray[B]` at abstract B.
 */
export function flatMapped(c: CollValue, tRange: SType, items: SValue[]): CollValue {
  void c // the two shapes of the JVM method produce the same class rule
  return fromArray(tRange, items, false)
}

/**
 * `CollOverArray.reverse` (:59-66):
 *     builder.fromArray(reversed Array[A])   (at :65)
 * Specialisation preserved; a pair item type on an array-shape receiver
 * routes to pairs with plain sides. This is how a plain CollOverArray[Tuple2]
 * (the result of `PairOfCols.map` at a pair tRange) restores the pair shape
 * when reversed.
 *
 * `PairOfCols.reverse` (:384-394):
 *     equal         → pairColl(ls.reverse, rs.reverse)
 *     ls shorter    → pairColl(ls.reverse, rs.slice(0, lLen).reverse)
 *     rs shorter    → pairColl(ls.slice(0, rLen).reverse, rs.reverse)
 * Each side is reversed; the longer side is pre-cut so that the reverse is
 * over the same items `pairColl` would keep.
 */
export function reversed(c: CollValue): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'pairs') {
    const { ls, rs } = splitSides(c, cls)
    const lLen = ls.items.length
    const rLen = rs.items.length
    if (lLen === rLen) return pairColl(reversed(ls), reversed(rs))
    if (lLen < rLen) return pairColl(reversed(ls), reversed(slice(rs, 0, lLen)))
    return pairColl(reversed(slice(ls, 0, rLen)), reversed(rs))
  }
  const items = c.items.slice().reverse()
  return fromArray(c.elem, items, cls.specialised)
}

/**
 * `CollOverArray.indices` (:68):
 *     builder.fromArray(toArray.indices.toArray)
 * `toArray.indices.toArray` is `Array[Int]`, so `fromArray[Int]` runs: the
 * specialised-for-Int subclass. Independent of the receiver's specialisation.
 *
 * `PairOfCols.indices` (:408):
 *     if (ls.length <= rs.length) ls.indices else rs.indices
 * The shorter side's indices — a specialised Coll[Int] either way (the side's
 * `indices` call bottoms out in a CollOverArray). Length of the result is the
 * pair's length, which this module stores as `c.items.length` for a pairs
 * value.
 */
export function indices(c: CollValue): CollValue {
  const n = c.items.length
  const items: SValue[] = new Array(n)
  for (let i = 0; i < n; i++) items[i] = { kind: 'Int', value: i }
  return withClass({ tag: 'SInt' }, items, {
    shape: 'array',
    specialised: true,
    array: 'int',
  })
}

/**
 * `CollOverArray.zip[B](ys)` (:42):
 *     builder.pairColl(this, ys)
 * `PairOfCols.zip[B](ys)` (:396):
 *     builder.pairColl(this, ys)
 * A pairs receiver nests INTO a new `PairOfCols`: its left side is the pairs
 * receiver itself.
 *
 * `pairColl(as, bs)` (:183-203):
 *     equal   → new PairOfCols(as, bs)
 *     as < bs → new PairOfCols(as, bs.slice(0, asLen))
 *     as > bs → new PairOfCols(as.slice(0, bsLen), bs)
 * Each side keeps its class; the longer side is cut with its own `slice`.
 */
export function zip(c: CollValue, ys: CollValue): CollValue {
  return pairColl(c, ys)
}

/**
 * `CollOverArray.getOrElse(i, default: A)` (:26):
 *     if (i >= 0 && i < toArray.length) toArray(i) else default
 * The class is `@specialized`. On a SPECIALISED receiver the default is
 * unboxed through `BoxesRunTime.unboxTo<T>` AT THE CALL, before the range
 * test, so a default whose runtime class is not the receiver's primitive
 * class throws, IN range and out. On a PLAIN receiver (whatever its array)
 * the default is an object and is returned as it is when out of range,
 * whatever its class; in range the item is returned.
 *
 * `PairOfCols.getOrElse(i, default)` (:309-315):
 *     if (i >= 0 && i < this.length) this.apply(i)
 *     else { val d = default; (d._1, d._2) }
 * In range the default is not read, so a non-pair default is ignored. Out of
 * range the default is read as a pair, so a default that is no pair throws,
 * and a default that IS a pair is returned whatever its components' classes
 * (measurement A of `.superpowers/sdd/2026-11-18-collection-value-model/
 *  measure-1.md`: a pair default with components of another class reduces on
 * every pair receiver, in range and out, at tree v0 and v3).
 *
 * A plain collection over `Tuple2[]` (shape `'array'`, array `'Tuple2'`: the
 * class of `Box.tokens` and of a `map` over a pair collection) is a
 * `CollOverArray`, so the plain rule applies: returns the item in range and
 * the default out of range, whatever its class.
 *
 * @throws CollClassCast when the default's class fails the unbox the
 *   specialised subclass runs, and when a non-pair default is read as a pair
 *   on a pairs receiver out of range. The evaluator's facade turns it into
 *   `EvalError('coll-class-cast')`.
 */
export function getOrElse(c: CollValue, i: number, d: SValue): SValue {
  const cls = classOf(c)
  const n = c.items.length
  const inBounds = i >= 0 && i < n
  if (cls.shape === 'pairs') {
    if (inBounds) return c.items[i]!
    if (d.kind === 'Tuple' && d.items.length === 2) return d
    throw new CollClassCast(
      `PairOfCols.getOrElse: a default of kind ${d.kind} is no pair`,
    )
  }
  if (cls.specialised) {
    const dClass = runtimeClassOf(d)
    if (dClass !== cls.array) {
      throw new CollClassCast(
        `Coll[${cls.array}].getOrElse: a default of class ${dClass} is not of the receiver's class`,
      )
    }
    return inBounds ? c.items[i]! : d
  }
  return inBounds ? c.items[i]! : d
}

/**
 * `CollOverArray.startsWith(ys)` (`CollsOverArrays.scala:44`) and `endsWith`
 * (`:46`):
 *     toArray.startsWith(ys.toArray)   /   toArray.endsWith(ys.toArray)
 * The class is `@specialized`. On a SPECIALISED receiver `ys.toArray` is cast
 * to the receiver's primitive array AT THE CALL, before any length test or
 * item read, so an argument whose array is of another class throws, an empty
 * one and a longer one included. On a PLAIN receiver (whatever its array)
 * nothing is cast: the items are compared pairwise with `itemEq`; a longer
 * argument gives `false`.
 *
 * `PairOfCols.startsWith(ys)` (`CollsOverArrays.scala:398-401`) and `endsWith`
 * (`:403-406`):
 *     ys match {
 *       case yp: PairOfCols[L, R] => ls.startsWith(yp.ls) && rs.startsWith(yp.rs)
 *       case _ => toArray.startsWith(ys.toArray)
 *     }
 * With a `'pairs'` argument: each side by its own class's rule, `&&` short-
 * circuiting — when the left sides give `false` the right sides are not read,
 * so a right-side cast that would throw does not throw here. With any other
 * argument: `this.toArray` is `Array[Tuple2]` (`:299`), so the fallback casts
 * the ARGUMENT's array to `Tuple2[]`. A primitive argument array throws, an
 * empty one included; a reference argument array passes the cast, and the
 * items are then compared pairwise by `itemEq` — the receiver's items are the
 * pairs, so an argument item that is no pair reduces to `false`.
 *
 * A plain `CollOverArray[Tuple2]` (the class of `Box.tokens` and of a `map`
 * over a pair collection) is an `'array'` shape: the plain rule applies.
 *
 * The caller (an evaluator arm) passes `sValueStructuralEq` as `itemEq`; this
 * module decides which items meet, in what order, and when to throw.
 *
 * @throws CollClassCast when a specialised receiver's array differs from the
 *   argument's, and when a pairs receiver's fallback meets a primitive
 *   argument. The evaluator's facade turns it into
 *   `EvalError('coll-class-cast')`.
 */
export function startsWith(
  c: CollValue,
  ys: CollValue,
  itemEq: (a: SValue, b: SValue) => boolean,
): boolean {
  return matchPrefix(c, ys, itemEq, 'start')
}

export function endsWith(
  c: CollValue,
  ys: CollValue,
  itemEq: (a: SValue, b: SValue) => boolean,
): boolean {
  return matchPrefix(c, ys, itemEq, 'end')
}

/**
 * `CollOverArray.patch(from, patch, replaced)` (`CollsOverArrays.scala:94-98`):
 *     val res = toArray.patch(from, patch.toArray, replaced).toArray
 *     builder.fromArray(res)
 * The class is `@specialized`. On a SPECIALISED receiver `patch.toArray` is cast
 * to the receiver's primitive array AT THE CALL, before any store, so a patch
 * whose array is of another class throws, empty included and whether anything
 * is replaced or not. The patch's object class is irrelevant — a plain
 * collection over the same primitive array passes; a `'pairs'` patch's
 * `toArray` is `Array[Tuple2]` (`:299`), a reference array, so it throws.
 *
 * On a PLAIN receiver `toArray.patch` allocates the result in the receiver's
 * class tag and stores each PATCH item into it. A primitive array fails the
 * store on an item of another class (`BoxesRunTime.unboxTo<T>`, mirrored by
 * `CollClassCast`); a reference array of `'Object'` takes anything; `'Coll'`
 * takes any collection, whatever its item type; another reference class takes
 * only its own (`ArrayStoreException`, mirrored by `CollArrayStore`). An EMPTY
 * patch stores nothing, so an empty patch of another class is answered on a
 * plain receiver — the row that separates the plain rule from the specialised
 * one.
 *
 * `PairOfCols.patch` (`CollsOverArrays.scala:423-428`):
 *     val (lsPatch, rsPatch) = builder.unzip(patch)
 *     builder.pairColl(ls.patch(from, lsPatch, replaced), rs.patch(from, rsPatch, replaced))
 * `unzip` (`:245-259`) takes the two sides of a `'pairs'` patch as they are and,
 * for any other patch, reads `xs.tItem.tFst`/`tSnd` and builds two plain-side
 * collections from the patch's items (`fromArray[A]`/`fromArray[B]` at erased A,
 * B — the sides come out plain). A patch whose `tItem` is no pair type fails
 * the `tFst` read (mirrored by `CollClassCast`). Each side then runs through
 * `CollOverArray.patch` with the receiver's side's class, so a specialised side
 * casts the patch's side's array.
 *
 * The result's items are `receiver[0, from) ++ patch ++ receiver[from+replaced, )`,
 * with `from` and `replaced` each clamped to `>= 0` (Scala's `Array.patch`:
 * `[1,2,3].patch(-1, [9], 1) = [9, 2, 3]`). The class is
 * `builder.fromArray(res)` from inside the receiver's class — specialised stays
 * specialised, plain stays plain, and a plain collection over `Tuple2[]` comes
 * back as `'pairs'` with plain sides through `fromBoxedPairs` (`:205-215`).
 *
 * @throws CollClassCast when a specialised receiver's array differs from the
 *   patch's, when a plain primitive receiver meets a patch item of another
 *   class, when a non-pair patch meets a pairs receiver, and when a side
 *   delegation hits one of these.
 * @throws CollArrayStore when a plain reference receiver meets a patch item
 *   whose class the array does not take.
 */
export function patch(
  c: CollValue,
  from: number,
  p: CollValue,
  replaced: number,
): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'pairs') {
    const sides = splitSides(c, cls)
    const patchSides = unzipForPatch(p)
    return pairColl(
      patch(sides.ls, from, patchSides.ls, replaced),
      patch(sides.rs, from, patchSides.rs, replaced),
    )
  }
  if (cls.specialised) {
    const pArray = argArrayClass(p)
    if (pArray !== cls.array) {
      throw new CollClassCast(
        `Coll[${cls.array}].patch: Array of ${pArray} is not of the receiver's class`,
      )
    }
  } else {
    for (const item of p.items) {
      checkStore(cls.array, item)
    }
  }
  const fromC = Math.max(0, from)
  const replacedC = Math.max(0, replaced)
  const items = [
    ...c.items.slice(0, fromC),
    ...p.items,
    ...c.items.slice(fromC + replacedC),
  ]
  // `builder.fromArray(res)` from inside the receiver's class: specialised
  // stays specialised, and a pair elem routes through `fromBoxedPairs` to
  // `'pairs'` with plain sides.
  return fromArray(c.elem, items, cls.specialised)
}

// ----- internals -----------------------------------------------------------

/** Build a pair-shape result from two side collections, using `pairColl`'s
 *  rule for unequal lengths (:183-203). Each side keeps its class. */
function pairColl(as: CollValue, bs: CollValue): CollValue {
  const asLen = as.items.length
  const bsLen = bs.items.length
  if (asLen === bsLen) return makePairs(as, bs)
  if (asLen < bsLen) return makePairs(as, slice(bs, 0, asLen))
  return makePairs(slice(as, 0, bsLen), bs)
}

/** Build a pairs collection whose sides are two length-matched CollValues.
 *  Reassembles the items as Tuple pairs and sets the pair elem to the two
 *  sides' elems. */
function makePairs(ls: CollValue, rs: CollValue): CollValue {
  const n = Math.min(ls.items.length, rs.items.length)
  const items: SValue[] = new Array(n)
  for (let i = 0; i < n; i++) {
    items[i] = { kind: 'Tuple', items: [ls.items[i]!, rs.items[i]!] }
  }
  return withClass(
    { tag: 'STuple', items: [ls.elem, rs.elem] },
    items,
    { shape: 'pairs', ls: classOf(ls), rs: classOf(rs) },
  )
}

/** The two sides of a pairs collection, each as a CollValue. */
function splitSides(
  c: CollValue,
  cls: Extract<CollClass, { shape: 'pairs' }>,
): { ls: CollValue; rs: CollValue } {
  const { ls: lsElem, rs: rsElem } = sideElems(c)
  const [lsItems, rsItems] = splitPairItems(c.items)
  return {
    ls: withClass(lsElem, lsItems, cls.ls),
    rs: withClass(rsElem, rsItems, cls.rs),
  }
}

/** The elem types of the two sides of a pairs collection. */
function sideElems(c: CollValue): { ls: SType; rs: SType } {
  if (c.elem.tag !== 'STuple' || c.elem.items.length !== 2) {
    throw new Error('coll/ops: pairs elem is not an STuple of 2 items')
  }
  return { ls: c.elem.items[0]!, rs: c.elem.items[1]! }
}

/**
 * The shared body of `startsWith` and `endsWith`. `from = 'end'` compares the
 * last `ys.length` items of the receiver against the argument.
 */
function matchPrefix(
  c: CollValue,
  ys: CollValue,
  itemEq: (a: SValue, b: SValue) => boolean,
  from: 'start' | 'end',
): boolean {
  const cls = classOf(c)
  if (cls.shape === 'pairs') {
    const ysCls = classOf(ys)
    if (ysCls.shape === 'pairs') {
      const { ls, rs } = splitSides(c, cls)
      const { ls: yls, rs: yrs } = splitSides(ys, ysCls)
      // ls.<op>(yp.ls) && rs.<op>(yp.rs), with the `&&` short-circuit: when
      // `ls` returns `false`, `rs` is not read, so a right side that would
      // throw does not throw here.
      if (!matchPrefix(ls, yls, itemEq, from)) return false
      return matchPrefix(rs, yrs, itemEq, from)
    }
    // Non-pair argument: the fallback casts the argument's array to `Tuple2[]`.
    if (isPrimitiveArrayClass(ysCls.array)) {
      throw new CollClassCast(
        `PairOfCols.${from === 'start' ? 'startsWith' : 'endsWith'}: Array of ${ysCls.array} is not a Tuple2[]`,
      )
    }
    return compareItems(c.items, ys.items, itemEq, from)
  }
  if (cls.specialised) {
    const ysArray = argArrayClass(ys)
    if (ysArray !== cls.array) {
      throw new CollClassCast(
        `Coll[${cls.array}].${from === 'start' ? 'startsWith' : 'endsWith'}: Array of ${ysArray} is not of the receiver's class`,
      )
    }
  }
  return compareItems(c.items, ys.items, itemEq, from)
}

/**
 * Walk `ys.items` against `recv.items`: from the start, or from the offset
 * that aligns their ends.
 */
function compareItems(
  recv: SValue[],
  ys: SValue[],
  itemEq: (a: SValue, b: SValue) => boolean,
  from: 'start' | 'end',
): boolean {
  if (ys.length > recv.length) return false
  const offset = from === 'start' ? 0 : recv.length - ys.length
  for (let i = 0; i < ys.length; i++) {
    if (!itemEq(recv[offset + i]!, ys[i]!)) return false
  }
  return true
}

/**
 * The class of the argument's underlying array. A `'pairs'` value's `toArray`
 * is `Array[Tuple2]` (`CollsOverArrays.scala:299`), a reference array.
 */
function argArrayClass(ys: CollValue): ArrayClass {
  const cls = classOf(ys)
  if (cls.shape === 'pairs') return 'Tuple2'
  return cls.array
}

/** The five primitive array kinds Scala specialises arrays on. */
function isPrimitiveArrayClass(c: ArrayClass): boolean {
  return c === 'boolean' || c === 'byte' || c === 'short' || c === 'int' || c === 'long'
}

/**
 * The class of a value for an array store, the rule `toArray.patch` runs on
 * each PATCH item against the new array's class (`CollsOverArrays.scala:94`
 * with `Array.ofDim[A]` at the receiver's class tag). Named after the JVM's
 * store check so `updated`, `updateMany` and `append` share the body.
 *
 * - `'Object'` is `Array[AnyRef]`: anything stores.
 * - `'Unit'` is Scala's `ArrayBuilder.ofUnit`, whose `++=` COUNTS what it is
 *   given and fills the result with units — the item is never looked at, and
 *   a Unit array takes anything (SANTA `Coll.reference_store_ops` 3.R1, 3.R3
 *   and 3.Q1; `scala-library-2.12.20 ArrayBuilder.ofUnit`).
 * - `'Coll'` takes any collection (`Array[Coll[_]]`, item type erased by the
 *   array's class tag). An item whose runtime class is not `'Coll'` is refused
 *   (`ArrayStoreException` → `CollArrayStore`).
 * - A primitive array tries to UNBOX each item; an item of another class
 *   fails the unbox (`BoxesRunTime.unboxTo<T>` → `ClassCastException` →
 *   `CollClassCast`).
 * - A reference array of one named class refuses an item whose runtime class
 *   is not that one (`ArrayStoreException` → `CollArrayStore`).
 */
function checkStore(array: ArrayClass, item: SValue): void {
  const itemClass = runtimeClassOf(item)
  if (array === 'Object' || array === 'Unit') return
  if (array === 'Coll') {
    if (itemClass !== 'Coll') {
      throw new CollArrayStore(
        `Array[Coll].store: item of class ${itemClass} is not a Coll`,
      )
    }
    return
  }
  if (isPrimitiveArrayClass(array)) {
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
 * `builder.unzip(patch)` (`CollsOverArrays.scala:245-259`), specialised for
 * `patch`'s side split. A `'pairs'` patch returns its two sides as they are
 * (the `case pa: PairColl` arm). Any other patch runs through the `case _`
 * arm, which reads `xs.tItem.tFst`/`tSnd` and builds two plain-side
 * collections from the patch's items — a patch whose `tItem` is no pair type
 * fails the read (mirrored by `CollClassCast`).
 */
function unzipForPatch(p: CollValue): { ls: CollValue; rs: CollValue } {
  const pcls = classOf(p)
  if (pcls.shape === 'pairs') {
    return splitSides(p, pcls)
  }
  if (p.elem.tag !== 'STuple' || p.elem.items.length !== 2) {
    throw new CollClassCast(
      `unzip: Coll[${p.elem.tag}] is not a Coll of pairs; tItem.tFst throws`,
    )
  }
  const [lsElem, rsElem] = p.elem.items as [SType, SType]
  const [lsItems, rsItems] = splitPairItems(p.items)
  return {
    ls: withClass(lsElem, lsItems, {
      shape: 'array', specialised: false, array: arrayClassOf(lsElem),
    }),
    rs: withClass(rsElem, rsItems, {
      shape: 'array', specialised: false, array: arrayClassOf(rsElem),
    }),
  }
}

/** Split an array of pair values into two arrays of components. */
function splitPairItems(items: SValue[]): [SValue[], SValue[]] {
  const n = items.length
  const ls: SValue[] = new Array(n)
  const rs: SValue[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const p = items[i]!
    if (p.kind !== 'Tuple' || p.items.length !== 2) {
      throw new Error('coll/ops: pair item is not a Tuple of 2')
    }
    ls[i] = p.items[0]!
    rs[i] = p.items[1]!
  }
  return [ls, rs]
}
