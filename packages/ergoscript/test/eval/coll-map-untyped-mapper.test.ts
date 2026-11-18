/**
 * The map arm's empty-output class when the mapper's static type is NOT
 * `SFunc` (ergots' own `SAny`): the empty result carries the unknown class,
 * not a concrete class guessed from the receiver's item type.
 *
 * Reach: no honest tree the ergots parser produces lands a mapper whose
 * `exprTpe` is not `SFunc`, since every mapper the parser can emit — a
 * `FuncValue`, an `If` / `BlockValue` whose result is a `FuncValue`, an
 * `Apply` whose func is a `FuncValue` — threads an `SFunc` type through
 * `exprTpe`. A `MethodCall` or `PropertyCall` can type as `SAny` in
 * ergots, but no method returns a function value in the JVM, so the
 * runtime value is not a lambda and `extractFuncValue` rejects before
 * this arm reaches the output-elem decision. The grid below hand-builds
 * the shape so any change to the arm's gate keeps the unknown-class
 * conclusion.
 */

import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Map as MapExpr, SValue } from '../../src/mir/types'
import { classOf } from '../../src/coll/class'

describe('Map arm — empty output with a mapper whose static type is not SFunc', () => {
  it('builds the empty collection of unknown class, not a guess from the receiver', () => {
    // A ValUse(99, SAny) typed statically as SAny, but bound at runtime to
    // a Lambda. `exprTpe(mapper)` returns `SAny`, not `SFunc`, so the arm
    // hits the non-SFunc path for `outElemTpe`.
    const closure: SValue = {
      kind: 'Lambda',
      closure: {
        argIds: [0],
        argTpes: [{ tag: 'SInt' }],
        body: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
        capturedEnv: Env.empty(),
      },
    }

    const mapExpr: MapExpr = {
      tag: 'Map',
      // Empty input of a concrete element type.
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SByte' },
          items: [],
          cls: { shape: 'array', specialised: true, array: 'byte' },
        },
      },
      // Mapper is a ValUse(99, SAny) → mapperTpe tag is SAny, not SFunc.
      mapper: { tag: 'ValUse', valId: 99, tpe: { tag: 'SAny' } },
    }

    const env = Env.empty().extend(99, closure)
    const ctx = makeContext()
    const result = evalExpr(mapExpr, env, ctx)

    expect(result.kind).toBe('Coll')
    expect((result as { items: unknown[] }).items).toEqual([])
    // The result's class is unknown: the mapper's static range is not
    // concrete and the output is empty, so the empty-of-the-receiver's-
    // own-class rule reaches through the unknown marker.
    expect(classOf(result as { kind: 'Coll'; elem: { tag: 'SByte' }; items: SValue[]; cls?: unknown } as never)).toEqual({ shape: 'unknown' })
  })
})
