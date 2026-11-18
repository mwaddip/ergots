/**
 * The evaluator's facade over the collection module (`eval/_coll.ts`) turns a
 * `CollTypeRefused` thrown inside the module into
 * `EvalError('unsupported-value-type')`. Every other error passes through
 * untouched.
 *
 * Mirrors the JVM's `sys.error` arm of `stypeToRType`
 * (`core/shared/src/main/scala/sigma/Evaluation.scala:54-55` at 6.0.7): the
 * item type has no runtime type.
 *
 * Also pins the two evaluator paths that reach the module through the facade
 * with such an item type:
 *   - `MapCollection.eval` (`transformers.scala:43` at 6.0.7:
 *     `Evaluation.stypeToRType(mapper.tpe.tRange)`) — a mapper whose declared
 *     range is a type variable;
 *   - `Slice` of a collection value handed in without `cls` whose `elem` is a
 *     type variable (the class is read from the data reader's rule at the
 *     module's entry).
 */

import { describe, it, expect } from 'vitest'
import { translateCollTypeRefused } from '../../src/eval/_coll'
import { CollArrayStore, CollClassCast, CollTypeRefused } from '../../src/coll'
import { EvalError, makeContext } from '../../src/eval/eval-context'
import { Env } from '../../src/eval/env'
import { evalExpr } from '../../src/eval/eval'
import { evalMap } from '../../src/eval/coll-map'
import { evalSlice } from '../../src/eval/coll-slice'
import type { Expr, Map as MapExpr, Slice as SliceExpr, SType } from '../../src/mir/types'

describe('the facade guard (eval/_coll.ts)', () => {
  it('translates CollTypeRefused into EvalError(unsupported-value-type) with the same message', () => {
    const inner = new CollTypeRefused('arrayClassOf: refuses STypeVar(T)', 'STypeVar')
    try {
      translateCollTypeRefused(() => { throw inner })
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('unsupported-value-type')
      expect((e as EvalError).message).toBe('arrayClassOf: refuses STypeVar(T)')
    }
  })

  it('translates CollClassCast into EvalError(coll-class-cast) with the same message', () => {
    const inner = new CollClassCast('Coll[byte].getOrElse: a default of class boolean is not of the receivers class')
    try {
      translateCollTypeRefused(() => { throw inner })
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('coll-class-cast')
      expect((e as EvalError).message).toBe('Coll[byte].getOrElse: a default of class boolean is not of the receivers class')
    }
  })

  it('translates CollArrayStore into EvalError(coll-array-store) with the same message', () => {
    const inner = new CollArrayStore('a store an array refuses')
    try {
      translateCollTypeRefused(() => { throw inner })
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('coll-array-store')
      expect((e as EvalError).message).toBe('a store an array refuses')
    }
  })

  it('passes every other error through untouched', () => {
    const other = new Error('something else')
    try {
      translateCollTypeRefused(() => { throw other })
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBe(other)
    }
    const evalErr = new EvalError('existing', 'cost-limit-exceeded')
    try {
      translateCollTypeRefused(() => { throw evalErr })
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBe(evalErr)
    }
  })

  it('returns the inner value when no throw', () => {
    expect(translateCollTypeRefused(() => 42)).toBe(42)
  })
})

describe('MapCollection whose mapper range is a type variable', () => {
  // The JVM's `MapCollection.eval` (transformers.scala:40-46 at 6.0.7) calls
  //   val tResItem = Evaluation.stypeToRType(mapper.tpe.tRange)
  // BEFORE the per-item loop. On `STypeVar`, `stypeToRType`'s `_ =>` arm
  // (`Evaluation.scala:54-55`) throws `sys.error`, which the blesser reads as
  // `errored` whether the input is empty or not.
  it('rejects with EvalError(unsupported-value-type) on an empty input, not a plain Error', () => {
    const SINT: SType = { tag: 'SInt' }
    const TVAR: SType = { tag: 'STypeVar', name: 'T' }
    // A mapper (x: Int) => (x as T) — body is a ValUse typed by the type
    // variable, so `exprTpe(mapper, v).result` returns T.
    const mapper: Expr = {
      tag: 'FuncValue',
      args: [{ id: 1, tpe: SINT }],
      body: { tag: 'ValUse', valId: 1, tpe: TVAR },
    }
    // An empty input skips the per-item loop so the facade's refusal is the
    // one the test sees (ergots runs the result-type check per item).
    const input: Expr = {
      tag: 'Const',
      tpe: { tag: 'SColl', elem: SINT },
      value: { kind: 'Coll', elem: SINT, items: [] },
    }
    const node: MapExpr = { tag: 'Map', input, mapper }
    try {
      evalMap(node, Env.empty(), makeContext({ treeVersion: 0 }))
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('unsupported-value-type')
    }
  })
})

describe('Slice of a collection value without cls whose elem is a type variable', () => {
  // The module reads the class from the data reader's rule when a value has
  // no `cls`. For an elem that `stypeToRType` refuses the module throws
  // `CollTypeRefused`; the facade turns it into `EvalError`.
  it('rejects with EvalError(unsupported-value-type), not a plain Error', () => {
    const TVAR: SType = { tag: 'STypeVar', name: 'T' }
    const input: Expr = {
      tag: 'Const',
      tpe: { tag: 'SColl', elem: TVAR },
      // A collection value hand-built with a type-variable elem and no `cls`
      // (the public API accepts such a value — the data reader's class is
      // what the module reads).
      value: { kind: 'Coll', elem: TVAR, items: [] },
    }
    const node: SliceExpr = {
      tag: 'Slice',
      input,
      from: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
      until: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
    }
    try {
      evalSlice(node, Env.empty(), makeContext({ treeVersion: 0 }))
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('unsupported-value-type')
    }
    void evalExpr // silence unused import
  })
})

// `void` keeps imports for type use and for referencing from the second
// MapCollection test's inner shape without exercising them at the top level.
void Env
