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
import { classOf, CollClassCast, runtimeClassOf, type CollClass, type CollValue } from './class'
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
