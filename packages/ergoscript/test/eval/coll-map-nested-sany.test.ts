/**
 * Map result-type check — nested-SAny tolerance (iter-22 regression).
 *
 * Root cause (mainnet h=1,012,685 tx 1 input 0): a Map whose mapper's STATIC
 * return type is `STuple[Coll[SByte], SAny]` (the second tuple element flows
 * from an un-resolved MethodCall, typed SAny by our phase-2a `exprTpe`) but
 * whose RUNTIME body yields the concrete `STuple[Coll[SByte], SLong]`. Our
 * per-item result-type check used strict `sTypeEquals`, and the iter-16 skip
 * only fired for a TOP-LEVEL SAny (`outElemTpe.tag === 'SAny'`). Here the top
 * level is STuple, so the check ran and `SLong` ≠ `SAny` threw
 * `lambda-result-type-mismatch`. sigma-rust tracks concrete types and doesn't
 * do this per-item check at all, so it accepted.
 *
 * Fix: compare with `sTypeEqualsModuloSAny` — SAny is a wildcard at ANY depth.
 */

import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { sTypeEqualsModuloSAny, hasSAny } from '../../src/mir/stype-helpers'
import type { Map as MapExpr, SType, SValue } from '../../src/mir/types'

describe('sTypeEqualsModuloSAny / hasSAny (iter-22 helpers)', () => {
  const tup = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })
  const coll = (e: SType): SType => ({ tag: 'SColl', elem: e })

  it('SAny is a wildcard at top level and nested', () => {
    expect(sTypeEqualsModuloSAny({ tag: 'SAny' }, { tag: 'SLong' })).toBe(true)
    expect(
      sTypeEqualsModuloSAny(tup(coll({ tag: 'SByte' }), { tag: 'SLong' }), tup(coll({ tag: 'SByte' }), { tag: 'SAny' }))
    ).toBe(true)
  })

  it('still rejects concrete-vs-concrete mismatches (no SAny)', () => {
    expect(sTypeEqualsModuloSAny(tup(coll({ tag: 'SByte' }), { tag: 'SLong' }), tup(coll({ tag: 'SByte' }), { tag: 'SInt' }))).toBe(false)
    expect(sTypeEqualsModuloSAny({ tag: 'SLong' }, { tag: 'SInt' })).toBe(false)
  })

  it('hasSAny detects SAny at any depth', () => {
    expect(hasSAny({ tag: 'SLong' })).toBe(false)
    expect(hasSAny(tup(coll({ tag: 'SByte' }), { tag: 'SLong' }))).toBe(false)
    expect(hasSAny(tup(coll({ tag: 'SByte' }), { tag: 'SAny' }))).toBe(true)
    expect(hasSAny(coll({ tag: 'SAny' }))).toBe(true)
  })
})

describe('Map result-type check — nested-SAny tolerance (iter-22)', () => {
  it('does not reject a tuple body whose declared type has a nested SAny', () => {
    // Mapper declared return: STuple[Coll[SByte], SAny] (2nd elem unresolved).
    // Body actually returns STuple[Coll[SByte], SLong] (concrete).
    // The mapper body is a ValUse typed STuple[Coll[SByte], SAny] but bound to
    // the concrete runtime tuple — mirrors how an un-resolved MethodCall result
    // flows through a ValDef/ValUse.
    const concreteTuple: SValue = {
      kind: 'Tuple',
      items: [
        { kind: 'Coll', elem: { tag: 'SByte' }, items: [{ kind: 'Byte', value: 7 }] },
        { kind: 'Long', value: 42n },
      ],
    }

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
        // Static type STuple[Coll[SByte], SAny]; evaluates to the concrete tuple.
        body: {
          tag: 'ValUse',
          valId: 99,
          tpe: { tag: 'STuple', items: [{ tag: 'SColl', elem: { tag: 'SByte' } }, { tag: 'SAny' }] },
        },
      },
    }

    const env = Env.empty().extend(99, concreteTuple)
    const ctx = makeContext()
    const result = evalExpr(mapExpr, env, ctx)

    expect(result.kind).toBe('Coll')
    // Output elem recovered concretely from the runtime item (no nested SAny).
    expect((result as { elem: unknown }).elem).toEqual({
      tag: 'STuple',
      items: [{ tag: 'SColl', elem: { tag: 'SByte' } }, { tag: 'SLong' }],
    })
  })
})
