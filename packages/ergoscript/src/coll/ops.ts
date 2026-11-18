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
import { collOverArray, empty, fromArray, storeIntoArray, storeIntoClass, withClass, type StoreMode } from './build'

/**
 * Whether a value carries the `'unknown'` class — an empty collection of
 * class ergots cannot name (`class.ts`). A reader by class treats it as an
 * empty collection of the receiver's own class gives, and a receiver of
 * this class takes each operation by its empty-receiver rule.
 */
function isUnknown(c: CollValue): boolean {
  return classOf(c).shape === 'unknown'
}

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
  if (cls.shape === 'unknown') {
    // The receiver is empty: every slice of it is empty, of the same class.
    return empty(c.elem)
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
  if (cls.shape === 'unknown') {
    // The receiver is empty: filter keeps nothing, so the result is of the
    // same class.
    return empty(c.elem)
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
 * `toArray.map(f)` builds through `ArrayBuilder.ofXXX.+=` (scala-library
 * 2.12.20). A primitive builder's `+=(prim)` unboxes the item at the call
 * site (`CollClassCast`). An `ofUnit`'s `+=(Unit)` casts the call-site
 * argument to `BoxedUnit` (`CollClassCast`; SANTA row #62). An `ofRef`'s
 * `+=(ref)` stores `elems(size) = elem` — a checked aastore
 * (`CollArrayStore`; row #53).
 *
 * `PairOfCols.map[V](f)` (:317-324):
 *     val res = new Array[V](limit)
 *     cfor(0)(_ < limit, _ + 1) { i => res(i) = f((ls(i), rs(i))) }
 *     new CollOverArray(res, builder)
 * Always plain, no pair routing: a pair `tRange` on a pairs receiver gives a
 * plain `Coll[Tuple2]` (row #34 takes any pair into `Array[Tuple2]`, row #55
 * refuses a non-pair). `new Array[V](limit); res(i) = elem` is a direct
 * aastore (`CollArrayStore`) for reference V (row #52 refuses a GroupElement
 * into `Box[]`) and for V = Unit (`BoxedUnit[]`, row #63). For primitive V
 * the aastore unboxes (`CollClassCast`).
 *
 * The caller (an evaluator arm) applies the lambda and passes the mapped
 * items at `tRange`.
 *
 * @throws CollClassCast / CollArrayStore under the rules above.
 */
export function mapped(c: CollValue, tRange: SType, items: SValue[]): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'unknown') {
    // An empty receiver: no items, no store. The arm picks `empty(tRange)`
    // over this function where `tRange` is ergots' own `SAny`; when a
    // concrete `tRange` reaches here, build the concrete empty.
    return fromArray(tRange, [], false)
  }
  const resultArray = arrayClassOf(tRange)
  const storeMode: StoreMode = cls.shape === 'pairs' ? 'astore' : 'builder-cast'
  for (const item of items) {
    storeIntoArray(resultArray, item, storeMode)
  }
  if (cls.shape === 'pairs') {
    // `new CollOverArray(res, builder)` written out at :322 — always plain,
    // no pair routing on a pair range.
    return collOverArray(tRange, items)
  }
  // `builder.fromArray` at abstract B — plain; a pair tRange routes through
  // `fromBoxedPairs` (:205-215) to `'pairs'` with plain sides.
  return fromArray(tRange, items, false)
}

/**
 * `CollOverArray.flatMap[B](f)` (:70-73):
 *     builder.fromArray(toArray.flatMap(x => f(x).toArray))
 * `PairOfCols.flatMap[B](f)` (:410-411):
 *     builder.fromArray(toArray.flatMap(p => f(p).toArray))
 * Both shapes go through `Array.flatMap[B]` at abstract B.
 *
 * `Array.flatMap` builds through `ArrayBuilder[B].++=`. A `Unit` builder's
 * `++=` (scala-library `ArrayBuilder.ofUnit`) runs `size += xs.size` and fills
 * the result with units — the items are DROPPED (row #42, row #66; row #48
 * compares the stored unit with `()`). An EMPTY part stores nothing, so the
 * items' class is never read whatever the builder (row #37 empty GroupElement
 * part into `Coll[Box]`, row #38 empty long part into `Coll[Byte]`). A
 * primitive builder's `++=` falls to the generic `super.++=` which iterates
 * and `+=(prim)` each item, unboxing at the call site (`CollClassCast` on
 * mismatch; row #39's non-empty long part into `Coll[Byte]` throws). A
 * reference builder's `+=` is an aastore on `elems(size) = elem`
 * (`CollArrayStore` on mismatch; row #21's non-empty GroupElement part into
 * `Coll[Box]` throws). Row #22 (`Coll[Coll[Int]]` + `Coll[Coll[Long]]` part)
 * answers: `Array[Coll[_]]` takes any `Coll`.
 *
 * The caller (an evaluator arm) applies the lambda per element and passes the
 * parts (one `CollValue` per per-element application) so each part's items
 * and class are visible to the store rule.
 *
 * @throws CollClassCast / CollArrayStore under the rules above.
 */
export function flatMapped(c: CollValue, tRange: SType, parts: CollValue[]): CollValue {
  void c // the two shapes of the JVM method produce the same class rule
  const resultArray = arrayClassOf(tRange)
  const outItems: SValue[] = []
  if (resultArray === 'Unit') {
    // `ArrayBuilder.ofUnit.++=` counts items and fills with units (scala-library
    // 2.12.20). Items of any class are never read.
    for (const part of parts) {
      for (let i = 0; i < part.items.length; i++) outItems.push({ kind: 'Unit' })
    }
    return fromArray(tRange, outItems, false)
  }
  for (const part of parts) {
    if (part.items.length === 0) continue // `++=` on an empty part is a no-op
    for (const item of part.items) {
      storeIntoArray(resultArray, item, 'astore')
      outItems.push(item)
    }
  }
  return fromArray(tRange, outItems, false)
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
  if (cls.shape === 'unknown') {
    // The receiver is empty: reverse keeps the empty result of the same class.
    return empty(c.elem)
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
 * `PairOfCols.getOrElse(i, default: (L, R))` (:309-315) is reached from the
 * generic `Coll.getOrElse(i: Int, default: A)` through a bridge method
 * whose `default: Object` is cast to `Tuple2` BEFORE the body runs. A
 * default that is no pair fails the bridge cast, in range or out.
 * Measured on sigma-state 6.0.7 (spend mode, D1 at tree v0 in range:
 * `ClassCastException: java.lang.Long cannot be cast to scala.Tuple2`). A
 * pair default's components are not checked: a pair whose components are
 * of another class reduces on every pair receiver, in range and out.
 *
 * A plain collection over `Tuple2[]` (shape `'array'`, array `'Tuple2'`: the
 * class of `Box.tokens` and of a `map` over a pair collection) is a
 * `CollOverArray`, so the plain rule applies: returns the item in range and
 * the default out of range, whatever its class.
 *
 * @throws CollClassCast when the default's class fails the unbox the
 *   specialised subclass runs, and when a non-pair default fails the
 *   pairs-receiver bridge cast (in range or out). The evaluator's facade
 *   turns it into `EvalError('coll-class-cast')`.
 */
export function getOrElse(c: CollValue, i: number, d: SValue): SValue {
  const cls = classOf(c)
  const n = c.items.length
  const inBounds = i >= 0 && i < n
  if (cls.shape === 'pairs') {
    // `PairOfCols.getOrElse(i: Int, default: (L, R))` is reached from the
    // generic `Coll.getOrElse(i: Int, default: A)` through a bridge method
    // whose `default: Object` is cast to `Tuple2` BEFORE the body runs
    // (`methods.scala` 12:2; `CollsOverArrays.scala:309`). A default that is
    // no pair fails the bridge cast, in range or out. Measured on
    // sigma-state 6.0.7, tree v0 in-range: `ClassCastException: java.lang.Long
    // cannot be cast to scala.Tuple2`.
    if (d.kind !== 'Tuple' || d.items.length !== 2) {
      throw new CollClassCast(
        `PairOfCols.getOrElse: a default of kind ${d.kind} is no pair`,
      )
    }
    if (inBounds) return c.items[i]!
    return d
  }
  if (cls.shape === 'unknown') {
    // The receiver is empty: every index is out of range, and the JVM, with
    // the real class, reads the default by that class's rule. ergots has no
    // class to cast through, so the default is returned unchecked — the
    // reader-by-class rule ("accept what an empty of the receiver's class
    // gives") degenerates here, since no concrete class was ever found.
    return d
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
  if (cls.shape === 'unknown') {
    // The receiver is empty, and its class ergots cannot name. The result
    // is the patch's items with the patch's own class: receiver[0,from) is
    // empty, receiver[from+replaced,) is empty, so the result is just the
    // patch. The JVM would allocate at the receiver's class tag; ergots
    // adopts the patch's class in its place.
    return withClass(p.elem, p.items.slice(), classOf(p))
  }
  if (cls.shape === 'pairs') {
    const sides = splitSides(c, cls)
    // An empty operand of unknown class stands in as two empty operands per
    // side: `patch` on each side with its own empty gives the receiver side
    // back by the side's class rule, and `pairColl` rebuilds the pair.
    const patchSides = isUnknown(p)
      ? { ls: empty(sides.ls.elem), rs: empty(sides.rs.elem) }
      : unzipForPatch(p)
    return pairColl(
      patch(sides.ls, from, patchSides.ls, replaced),
      patch(sides.rs, from, patchSides.rs, replaced),
    )
  }
  let stored: SValue[]
  // An empty operand of unknown class stores nothing: skip the specialised
  // receiver's cast of the patch's array and the plain receiver's per-item
  // store (which is a no-op on an empty operand).
  const pUnknown = isUnknown(p)
  if (cls.specialised) {
    if (!pUnknown) {
      const pArray = argArrayClass(p)
      if (pArray !== cls.array) {
        throw new CollClassCast(
          `Coll[${cls.array}].patch: Array of ${pArray} is not of the receiver's class`,
        )
      }
    }
    stored = p.items
  } else if (pUnknown) {
    stored = p.items
  } else {
    // `Array.patch` on `Array[A]` builds through the A-class's
    // `ArrayBuilder` (scala-library 2.12.20): a `Unit` array's builder
    // drops the stored value and keeps a unit, hence `'drop-unit'`.
    stored = p.items.map((item) => storeIntoArray(cls.array, item, 'drop-unit'))
  }
  const fromC = Math.max(0, from)
  const replacedC = Math.max(0, replaced)
  const items = [
    ...c.items.slice(0, fromC),
    ...stored,
    ...c.items.slice(fromC + replacedC),
  ]
  // `builder.fromArray(res)` from inside the receiver's class: specialised
  // stays specialised, and a pair elem routes through `fromBoxedPairs` to
  // `'pairs'` with plain sides.
  return fromArray(c.elem, items, cls.specialised)
}

/**
 * `CollOverArray.updated(index, elem)` (`CollsOverArrays.scala:100-104`):
 *     val res = toArray.updated(index, elem)
 *     builder.fromArray(res)
 * `toArray.updated` is Scala's `ArrayOps.updated`: a new `Array[A]` of the
 * receiver's class tag, `Array.copy` from the receiver's array, then
 * `dest(index) = elem`. On the specialised subclass `elem` arrives unboxed —
 * an item of another class fails the unbox at the call (`CollClassCast`).
 * On a plain receiver the item is stored into the new array of the
 * receiver's class tag — a primitive array refuses an item of another class
 * (unbox → `CollClassCast`); a reference array of `'Object'` takes
 * anything; `'Unit'` on this direct-store path refuses an item of another
 * class (SANTA row #44); `'Coll'` takes any collection; another reference
 * class takes only its own (`ArrayStoreException` → `CollArrayStore`).
 *
 * `PairOfCols.updated(index, elem)` (`:430-434`):
 *     val lu = ls.updated(index, elem._1)
 *     val ru = rs.updated(index, elem._2)
 *     builder.pairColl(lu, ru)
 * The item is read as a pair (`CollClassCast` when it is not); each side's
 * `updated` runs by that side's class, and `builder.pairColl` keeps each
 * side's class.
 *
 * The caller (an evaluator handler) checks the index is in range and the
 * cost is charged; this function assumes `0 <= index < c.items.length`.
 *
 * @throws CollClassCast when a specialised receiver's primitive class
 *   refuses the item (unbox), when a pairs receiver reads a non-pair item
 *   or one of its sides' specialised-primitive rule rejects, and through
 *   a side delegation when the side's rule rejects.
 * @throws CollArrayStore when a plain reference receiver refuses the item
 *   by its array's class (Unit, Coll, or a named reference class).
 */
export function updated(c: CollValue, index: number, item: SValue): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'pairs') {
    if (item.kind !== 'Tuple' || item.items.length !== 2) {
      throw new CollClassCast(
        `PairOfCols.updated: item of kind ${item.kind} is no pair`,
      )
    }
    const sides = splitSides(c, cls)
    const [lhs, rhs] = item.items as [SValue, SValue]
    return pairColl(
      updated(sides.ls, index, lhs),
      updated(sides.rs, index, rhs),
    )
  }
  if (cls.shape === 'unknown') {
    // The receiver is empty: an index-in-range call should never reach this
    // function (the arm's bounds check rejects first). A caller through the
    // public API reaches here, and the module gives its typed error with no
    // plain `Error`.
    throw new CollClassCast(
      `Coll[unknown].updated: receiver is empty; no index can be in range`,
    )
  }
  let toStore: SValue
  if (cls.specialised) {
    const itemClass = runtimeClassOf(item)
    if (itemClass !== cls.array) {
      throw new CollClassCast(
        `Coll[${cls.array}].updated: item of class ${itemClass} fails unbox to ${cls.array}`,
      )
    }
    toStore = item
  } else {
    toStore = storeIntoArray(cls.array, item, 'astore')
  }
  const items = c.items.slice()
  items[index] = toStore
  return fromArray(c.elem, items, cls.specialised)
}

/**
 * `CollOverArray.updateMany(indexes, values)` (`CollsOverArrays.scala:106-117`):
 *     requireSameLength(indexes, values)
 *     val resArr = toArray.clone()
 *     while (i < indexes.length) {
 *       val pos = indexes(i)
 *       if (pos < 0 || pos >= toArray.length) throw IndexOutOfBoundsException
 *       resArr(pos) = values(i)
 *     }
 *     builder.fromArray(resArr)
 * The clone has the receiver's class tag. Each store checks the value
 * against the array's class (same rules as `updated`).
 *
 * `PairOfCols.updateMany(indexes, values)` (`:436-450`):
 *     requireSameLength(indexes, values)
 *     resL = ls.toArray.clone(); resR = rs.toArray.clone()
 *     while (i < indexes.length) {
 *       val pos = indexes(i); bounds check
 *       resL(pos) = values(i)._1
 *       resR(pos) = values(i)._2
 *     }
 *     builder.pairColl(builder.fromArray(resL), builder.fromArray(resR))
 * `builder.fromArray` runs at erased L and R, so the result's sides come
 * out PLAIN whatever the receiver's sides were.
 *
 * The caller (an evaluator handler) checks index/values length match, each
 * index's kind and bounds, and charges the cost; this function assumes
 * `indexes.length === values.items.length` and each index is in range.
 *
 * @throws CollClassCast / CollArrayStore under the same rules as `updated`.
 */
export function updateMany(c: CollValue, indexes: number[], values: CollValue): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'pairs') {
    const sides = splitSides(c, cls)
    const { ls: lsElem, rs: rsElem } = sideElems(c)
    const newLs = sides.ls.items.slice()
    const newRs = sides.rs.items.slice()
    for (let k = 0; k < indexes.length; k++) {
      const v = values.items[k]!
      if (v.kind !== 'Tuple' || v.items.length !== 2) {
        throw new CollClassCast(
          `PairOfCols.updateMany: value of kind ${v.kind} is no pair`,
        )
      }
      const lhs = storeIntoClass(cls.ls, v.items[0]!)
      const rhs = storeIntoClass(cls.rs, v.items[1]!)
      newLs[indexes[k]!] = lhs
      newRs[indexes[k]!] = rhs
    }
    return pairColl(
      fromArray(lsElem, newLs, false),
      fromArray(rsElem, newRs, false),
    )
  }
  if (cls.shape === 'unknown') {
    // The receiver is empty. An empty indexes array is a no-op: the result
    // is the receiver as it is. A non-empty indexes array names an index
    // the receiver cannot have in range, and the module gives its typed
    // error.
    if (indexes.length === 0) return c
    throw new CollClassCast(
      `Coll[unknown].updateMany: receiver is empty; no index can be in range`,
    )
  }
  const items = c.items.slice()
  for (let k = 0; k < indexes.length; k++) {
    const v = values.items[k]!
    if (cls.specialised) {
      const vClass = runtimeClassOf(v)
      if (vClass !== cls.array) {
        throw new CollClassCast(
          `Coll[${cls.array}].updateMany: value of class ${vClass} fails unbox to ${cls.array}`,
        )
      }
      items[indexes[k]!] = v
    } else {
      items[indexes[k]!] = storeIntoArray(cls.array, v, 'astore')
    }
  }
  return fromArray(c.elem, items, cls.specialised)
}

/**
 * `CollOverArray.append(other)` (`CollsOverArrays.scala:48-57`):
 *     if (toArray.length <= 0) return other
 *     val result = safeConcatArrays_v5(toArray, other.toArray)(tA.classTag)
 *     builder.fromArray(result)
 * An EMPTY receiver returns the operand UNREAD, with ITS class and `elem`,
 * whatever they are (`:49`; the SANTA row `append_empty_box_recv_ge_arg-
 * accept#2` carries it). Otherwise `safeConcatArrays_v5` (`sigma/util/
 * package.scala:25-29`) allocates `new Array[A]` at the receiver's class
 * tag and `System.arraycopy`s each array in (`CollectionUtil.scala:34-45`,
 * two bare `System.arraycopy`s into one new array):
 *   - A SPECIALISED receiver's A is a primitive type; the method's
 *     specialised variant checkcasts the parameter `other: Coll[A]` to the
 *     receiver's primitive array class — an operand over another array
 *     fails even when empty (`CollClassCast`; SANTA
 *     `Append.reference_array_store` and `Coll.append_concat_v6`).
 *   - A PLAIN receiver over a PRIMITIVE array has `tA.classTag` of that
 *     primitive. `new Array[A]` is the primitive array and
 *     `System.arraycopy` from another-typed source fails the component-type
 *     check upfront, empty included (`CollArrayStore`).
 *   - A PLAIN receiver over a REFERENCE array: `new Array[A]` is a
 *     reference array. `System.arraycopy` from a reference source does a
 *     per-element check when the component types are not assignment-
 *     compatible — an EMPTY source has no items to check and is accepted
 *     (SANTA `append_ge_empty_box_arg-accept#0`); a non-empty source with
 *     items of another class throws `ArrayStoreException` on the first
 *     item (`CollArrayStore`; SANTA `unit-coll-append-box-errored#46`).
 *   - A PLAIN receiver over a REFERENCE array + PRIMITIVE source: the
 *     component types' incompatibility fails `System.arraycopy` upfront,
 *     empty included (`CollArrayStore`).
 *
 * `PairOfCols.append(other)` (`:379-382`):
 *     val arrs = builder.unzip(other)
 *     builder.pairColl(ls.append(arrs._1), rs.append(arrs._2))
 * `unzip` (`:245-259`) reads the operand's `tItem.tFst`/`tSnd` on a non-
 * pair operand — a `tItem` that is no pair fails (`CollClassCast`); each
 * side's `append` then runs.
 *
 * The caller (an evaluator arm) charges the cost; this function builds the
 * result.
 *
 * @throws CollClassCast / CollArrayStore under the rules above.
 */
export function append(c: CollValue, other: CollValue): CollValue {
  const cls = classOf(c)
  if (cls.shape === 'unknown') {
    // The empty-receiver rule, which `CollsOverArrays.scala:49` applies
    // before any class read: an empty receiver returns the operand unread.
    return other
  }
  if (cls.shape === 'pairs') {
    const sides = splitSides(c, cls)
    // An empty operand of unknown class stands in as two empty operands per
    // side: `append` on each side with its own empty gives the receiver
    // side back by the side's class rule, and `pairColl` rebuilds the pair.
    const otherSides = isUnknown(other)
      ? { ls: empty(sides.ls.elem), rs: empty(sides.rs.elem) }
      : unzipForPatch(other)
    return pairColl(
      append(sides.ls, otherSides.ls),
      append(sides.rs, otherSides.rs),
    )
  }
  if (c.items.length === 0) return other
  // An empty operand of unknown class stands in as an empty of the receiver's
  // own class: the result's items are the receiver's, and the result's class
  // is the receiver's. The JVM has the real range at the call and answers;
  // ergots takes the receiver's class, which gives the same items.
  if (isUnknown(other)) {
    return fromArray(c.elem, c.items.slice(), cls.specialised)
  }
  const otherArray = argArrayClass(other)
  if (cls.specialised) {
    if (otherArray !== cls.array) {
      throw new CollClassCast(
        `Coll[${cls.array}].append: operand's array ${otherArray} is not of the receiver's class`,
      )
    }
  } else if (isPrimitiveArrayClass(cls.array)) {
    if (otherArray !== cls.array) {
      throw new CollArrayStore(
        `Array[${cls.array}].append: operand's array ${otherArray} fails the component-type check`,
      )
    }
  } else {
    if (isPrimitiveArrayClass(otherArray)) {
      throw new CollArrayStore(
        `Array[${cls.array}].append: operand's primitive array ${otherArray} fails the component-type check`,
      )
    }
    for (const item of other.items) {
      storeIntoArray(cls.array, item, 'astore')
    }
  }
  const items = [...c.items, ...other.items]
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
  if (cls.shape === 'unknown') {
    // The receiver is empty: a prefix/suffix match succeeds iff the argument
    // is also empty. No class cast runs, since no concrete class was found.
    return ys.items.length === 0
  }
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
    if (ysCls.shape === 'unknown') {
      // An empty argument of unknown class: the receiver's `toArray.startsWith`
      // reads nothing, so it reduces to true.
      return true
    }
    // Non-pair argument: the fallback casts the argument's array to `Tuple2[]`.
    if (isPrimitiveArrayClass(ysCls.array)) {
      throw new CollClassCast(
        `PairOfCols.${from === 'start' ? 'startsWith' : 'endsWith'}: Array of ${ysCls.array} is not a Tuple2[]`,
      )
    }
    return compareItems(c.items, ys.items, itemEq, from)
  }
  // An empty argument of unknown class skips the receiver's array cast.
  if (isUnknown(ys)) return true
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
 * is `Array[Tuple2]` (`CollsOverArrays.scala:299`), a reference array. An
 * unknown-class empty argument's array ergots cannot name; the caller
 * handles the unknown case first and does not call this function on it, so
 * reaching here with an unknown value is a caller contract violation.
 */
function argArrayClass(ys: CollValue): ArrayClass {
  const cls = classOf(ys)
  if (cls.shape === 'pairs') return 'Tuple2'
  if (cls.shape === 'unknown') {
    throw new CollClassCast(
      `argArrayClass: an unknown-class value has no named array; the caller must branch on it first`,
    )
  }
  return cls.array
}

/** The five primitive array kinds Scala specialises arrays on. */
function isPrimitiveArrayClass(c: ArrayClass): boolean {
  return c === 'boolean' || c === 'byte' || c === 'short' || c === 'int' || c === 'long'
}

// `storeIntoArray`, `storeIntoClass` and `StoreMode` live in `coll/build.ts`:
// the module's one store helper, shared by the pair builder (`fromArray`'s
// pair-elem path), the `unzip` fallback (`unzipForPatch`), and the per-item
// stores of `patch` / `updated` / `updateMany` / `append` / `mapped` /
// `flatMapped`. The three modes differ only in how an array of `'Unit'`
// handles an item of another class:
//   - `'drop-unit'`: `ArrayBuilder.ofUnit.++=` drops the stored value and
//     fills with units (scala-library 2.12.20; SANTA rows #40, #41, #56 for
//     patch; #42, #48 for flatMap).
//   - `'astore'`: a direct `res(i) = elem` into `new Array[Unit]` =
//     `BoxedUnit[]`: an aastore check (`CollArrayStore`; SANTA rows #44, #45,
//     #63).
//   - `'builder-cast'`: `ArrayBuilder.ofUnit.+=(Unit)` with a call-site unbox
//     cast to `BoxedUnit` (`CollClassCast`; SANTA row #62).
// Primitive-array paths are `CollClassCast` across modes; reference-array
// mismatches are `CollArrayStore`.

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
  const lsArray = arrayClassOf(lsElem)
  const rsArray = arrayClassOf(rsElem)
  // The JVM's `unzip` fallback (`CollsOverArrays.scala:245-259`) allocates
  // `Array.ofDim[A](limit)(tA.classTag)` and `Array.ofDim[B](...)` and stores
  // `p._1` / `p._2` through the aastore: a component whose class is not the
  // side's array class throws. Share the pair builder's rule through the
  // one store helper.
  for (const item of lsItems) storeIntoArray(lsArray, item, 'astore')
  for (const item of rsItems) storeIntoArray(rsArray, item, 'astore')
  return {
    ls: withClass(lsElem, lsItems, {
      shape: 'array', specialised: false, array: lsArray,
    }),
    rs: withClass(rsElem, rsItems, {
      shape: 'array', specialised: false, array: rsArray,
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
