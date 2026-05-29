/**
 * Map arm — SAny output-elem derivation (iter-19 regression).
 *
 * Root cause (mainnet h=972,235 tx 5 input 0): a Map whose mapper body has
 * STATIC type SAny (because its result flows from a MethodCall — `getMany` on
 * SAvlTree — whose return type our phase-2a `exprTpe` does not statically
 * resolve, returning SAny) but whose RUNTIME items are concrete collections.
 *
 * Pre-fix, `evalMap` step 6 used the static `outElemTpe` verbatim even when it
 * was SAny, so the produced collection's `elem` was SAny. Downstream, that
 * collection was sliced and fed into a second Map whose mapper declared a
 * concrete `Coll[SByte]` arg; the runtime elem-type check (`coll-elem-tpe-
 * mismatch`) then rejected SAny ≠ Coll[SByte]. sigma-rust never hits this:
 * its `Map::new` resolves the mapper's `t_range` concretely at parse time.
 *
 * Fix: when the statically-derived `outElemTpe` is SAny (or null) and the
 * output is non-empty, derive the output elem from the concrete runtime items
 * (`inferSType(outItems[0])`). This mirrors the iter-16 SAny-tolerance already
 * applied to the per-item result-type CHECK in the same file, and is correct
 * because for a non-empty output the runtime item type IS the mapper's range.
 *
 * This test builds the minimal shape directly: a Map whose mapper body is a
 * `ValUse` typed SAny but bound at runtime to a concrete `Coll[SByte]` value.
 */

import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Map as MapExpr, SValue } from '../../src/mir/types'

describe('Map arm — SAny output-elem derivation (iter-19)', () => {
  it('derives concrete output elem from runtime items when mapper result type is SAny', () => {
    // val 99 is bound to a concrete Coll[SByte] value at runtime, but the
    // ValUse node that reads it is typed SAny (as our parser records for
    // values produced by un-resolved MethodCalls). The mapper ignores its
    // argument and returns this collection for each input element.
    const concreteColl: SValue = {
      kind: 'Coll',
      elem: { tag: 'SByte' },
      items: [{ kind: 'Byte', value: 1 }],
    }

    // input: Coll[SInt] with a single element (so the map loop runs once and
    // the output is non-empty). Mapper arg type SInt matches the input elem,
    // so the input elem-type check passes.
    const mapExpr: MapExpr = {
      tag: 'Map',
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 0 }] },
      },
      mapper: {
        tag: 'FuncValue',
        args: [{ id: 0, tpe: { tag: 'SInt' } }],
        // Body is statically SAny but evaluates to the concrete Coll[SByte].
        body: { tag: 'ValUse', valId: 99, tpe: { tag: 'SAny' } },
      },
    }

    const env = Env.empty().extend(99, concreteColl)
    const ctx = makeContext()
    const result = evalExpr(mapExpr, env, ctx)

    expect(result.kind).toBe('Coll')
    // The output collection's elem must be the concrete Coll[SByte], NOT SAny.
    // Pre-fix this was { tag: 'SAny' }.
    expect((result as { elem: unknown }).elem).toEqual({
      tag: 'SColl',
      elem: { tag: 'SByte' },
    })
  })

  it('does not reject an empty SAny-elem input against a concrete mapper arg type', () => {
    // The actual mainnet shape (h=972,235 tx 5 input 0): a Map over an EMPTY
    // collection whose runtime elem is SAny (because it was produced by an
    // earlier Map whose mapper result type was unresolved), against a mapper
    // declaring a concrete `Coll[SByte]` arg. With no items, runtime-inference
    // can't recover the type, so the input elem-type check must TOLERATE SAny
    // (skip it) rather than reject — sigma-rust has a concrete empty coll here
    // and its check passes. Pre-fix this threw 'coll-elem-tpe-mismatch'.
    const mapExpr: MapExpr = {
      tag: 'Map',
      input: {
        tag: 'Const',
        // empty Coll whose element type is the unresolved SAny placeholder
        tpe: { tag: 'SColl', elem: { tag: 'SAny' } },
        value: { kind: 'Coll', elem: { tag: 'SAny' }, items: [] },
      },
      mapper: {
        tag: 'FuncValue',
        args: [{ id: 0, tpe: { tag: 'SColl', elem: { tag: 'SByte' } } }],
        // Body never runs (empty input); its concrete type is the mapper range.
        body: {
          tag: 'SizeOf',
          input: { tag: 'ValUse', valId: 0, tpe: { tag: 'SColl', elem: { tag: 'SByte' } } },
        },
      },
    }

    const ctx = makeContext()
    // Must not throw; an empty input yields an empty output collection.
    const result = evalExpr(mapExpr, Env.empty(), ctx)
    expect(result.kind).toBe('Coll')
    expect((result as { items: unknown[] }).items).toHaveLength(0)
  })
})
