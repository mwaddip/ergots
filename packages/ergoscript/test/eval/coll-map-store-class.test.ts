/**
 * `map` and `flatMap` store through the result's array (phase: collection
 * value model stage 1). Each case rebuilds the tree of a SANTA
 * `Coll.reference_store_ops` row with the MIR helpers and runs the evaluator
 * — the row's `expected.value` or `expected.error` is the pin.
 *
 * `CollOverArray.map` (CollsOverArrays.scala:28-31 at 6.0.7) stores each
 * mapped item through an `ArrayBuilder.ofXXX.+=`; `PairOfCols.map`
 * (:317-324) stores into `new Array[V](n)` by direct aastore;
 * `CollOverArray.flatMap` (:70-73) and `PairOfCols.flatMap` (:410-411) add
 * each part with `builder.++=`, where `ofUnit.++=` counts and drops items.
 * `FuncValue.eval` (values.scala:1069-1086) reads the body's `tpe` after each
 * application and calls `Value.checkType(body, res)`
 * (`isValueOfType`, SType.scala:187-213) — a SHAPE check that a Coll[Long]
 * fits an `SCollectionType` declared range (row #20).
 */

import { describe, it, expect } from 'vitest'
import { evalSantaEntry, type SantaEntry } from '../conformance/_santa'

function entry(tree_bytes_hex: string): SantaEntry {
  return {
    name: 'test',
    tree_bytes_hex,
    input: { kind: 'Int', value: 0 },
    version: { activated: 3, ergoTree: 3 },
    expected: { value: null, cost: null, error: null },
  }
}

function expectAnswers(hex: string): void {
  const r = evalSantaEntry(entry(hex))
  expect(r.error).toBe(null)
}

function expectThrows(hex: string): void {
  const r = evalSantaEntry(entry(hex))
  expect(r.error).toBe('errored')
}

describe('MapCollection stores through the result array class — Coll.reference_store_ops rows', () => {
  it('#20 map-lambda-class-compatible-lie-accept — Coll(1).map({x => If(false, Coll(1), Coll(1L))}) answers (JVM: isValueOfType passes; Array[Coll[_]] takes any Coll)', () => {
    expectAnswers('0b16b1ad100102d901010495010083010404028301050502')
  })

  it('#53 map-two-lambdas-groupelement-errored — Coll(1).map(If(false, {x => SELF}, {x => groupGenerator})) throws (JVM: CollOverArray.map stores a GroupElement into Box[])', () => {
    expectThrows('0b12b1ad100102950100d9010104a7d901010482')
  })

  it('#62 map-two-lambdas-int-into-unit-errored — Coll(1).map(If(false, {x => ()}, {x => 1})) throws (JVM: ArrayBuilder.ofUnit.+= casts Int to BoxedUnit)', () => {
    expectThrows('0b15b1ad8301040402950100d901010462d90101040402')
  })

  it('#34 pair-map-pair-component-lie-accept — Coll(1).zip(Coll(1)).map({p => If(false, (1, SELF), (1, g))}) answers (JVM: PairOfCols.map builds Array[Tuple2] which takes any pair)', () => {
    expectAnswers('0b1db1addc0c1d10010201100102d901015895010086020402a78602040282')
  })

  it('#36 pair-map-lie-updated-accept — #34 then .updated(0, (1, SELF)) answers (the misfit is replaced before any rebuild)', () => {
    expectAnswers('0b28b1dc0c14addc0c1d10010201100102d901015895010086020402a7860204028202040086020402a7')
  })

  it('#52 pair-map-two-lambdas-groupelement-errored — Coll(1).zip(Coll(1)).map(If(false, {p => SELF}, {p => groupGenerator})) throws (JVM: PairOfCols.map new Array[V]=Box[] + aastore)', () => {
    expectThrows('0b19b1addc0c1d10010201100102950100d9010158a7d901015882')
  })

  it('#55 pair-map-two-lambdas-nonpair-errored — Coll(1).zip(Coll(1)).map(If(false, {p => (1, SELF)}, {p => groupGenerator})) throws (JVM: PairOfCols.map Array[Tuple2] + aastore refuses a non-pair)', () => {
    expectThrows('0b1db1addc0c1d10010201100102950100d901015886020402a7d901015882')
  })

  it('#63 pair-map-two-lambdas-int-into-unit-errored — Coll(1).zip(Coll(1)).map(If(false, {p => ()}, {p => 1})) throws (JVM: new Array[Unit]=BoxedUnit[] + aastore)', () => {
    expectThrows('0b1eb1addc0c1d8301040402018301040402950100d901015862d90101580402')
  })
})

describe('flatMap stores through the result array class — Coll.reference_store_ops rows', () => {
  it('#22 flatmap-coll-of-coll-long-accept — Coll(1).flatMap({x => If(false, Coll[Coll[Int]](Coll(1)), Coll[Coll[Long]](Coll(1L)))}) answers (JVM: Array[Coll[_]] takes any Coll per item)', () => {
    expectAnswers('0b1fb1dc0c0f10010201d901010495010083011083010404028301118301050502')
  })

  it('#37 flatmap-empty-groupelement-part-accept — Coll(1).flatMap({x => If(false, Coll[Box](SELF), Coll[GroupElement]())}) answers (empty part stores nothing; sizeOf=0)', () => {
    expectAnswers('0b16b1dc0c0f10010201d9010104950100830163a7830007')
  })

  it('#38 flatmap-empty-long-part-into-bytes-accept — empty long part into byte result accepted (never iterated)', () => {
    expectAnswers('0b15b1dc0c0f10010201d90101049501000e0101830005')
  })

  it('#42 flatmap-int-part-into-unit-accept — Unit builder ++= counts and drops (JVM ArrayBuilder.ofUnit.++=)', () => {
    expectAnswers('0b16b1dc0c0f10010201d901010495010083016262100102')
  })

  it('#48 flatmap-unit-result-eq-accept — #42 == Coll[Unit](()) is true', () => {
    expectAnswers('0b1a93dc0c0f10010201d90101049501008301626210010283016262')
  })

  it('#66 pair-flatmap-int-part-into-unit-accept — PairOfCols.flatMap through ArrayBuilder.ofUnit.++= answers', () => {
    expectAnswers('0b21b1dc0c0fdc0c1d830104040201830104040201d901015895010083016262100102')
  })
})
