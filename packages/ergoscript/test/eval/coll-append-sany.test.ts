/**
 * Append SAny elem-type tolerance (iter-21 regression).
 *
 * Root cause (mainnet h=974,407 tx 8 input 1): `Append(input, col2)` where one
 * operand's runtime elem is concrete (`Coll[SByte]`) and the other's is `SAny`
 * (an unresolved-type collection — e.g. an empty coll produced by a getMany/Map
 * chain whose element type our phase-2a `exprTpe` couldn't resolve). Both
 * sigma-rust and our evaluator check elem-type equality at eval time
 * (coll_append.rs), but sigma-rust tracks concrete types so its check passes;
 * ours rejected the `Coll[SByte]` vs `SAny` pair → `coll-elem-tpe-mismatch`.
 *
 * Fix: tolerate SAny in the check (skip when either elem is SAny) and prefer the
 * concrete side for the output elem. Same SAny-tolerance principle as iter-19
 * (Map) and the ByIndex/OptionGet/SelectField arms.
 */

import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Append, SValue } from '../../src/mir/types'

describe('Append SAny elem-type tolerance (iter-21)', () => {
  it('does not reject concrete Coll[Coll[SByte]] appended with an SAny-elem coll', () => {
    // input: Coll[Coll[SByte]] with one inner coll. col2: empty Coll whose elem
    // is the unresolved SAny placeholder (mirrors an empty getMany/Map result).
    const innerByteColl: SValue = { kind: 'Coll', elem: { tag: 'SByte' }, items: [{ kind: 'Byte', value: 1 }] }
    const expr: Append = {
      tag: 'Append',
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SByte' } } },
        value: { kind: 'Coll', elem: { tag: 'SColl', elem: { tag: 'SByte' } }, items: [innerByteColl] },
      },
      col2: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SAny' } },
        value: { kind: 'Coll', elem: { tag: 'SAny' }, items: [] },
      },
    }

    const ctx = makeContext()
    const result = evalExpr(expr, Env.empty(), ctx)
    expect(result.kind).toBe('Coll')
    // Output elem comes from the concrete (input) side, NOT SAny.
    expect((result as { elem: unknown }).elem).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
    // Items = input's items + col2's (empty) = 1.
    expect((result as { items: unknown[] }).items).toHaveLength(1)
  })

  it('prefers the concrete elem when the FIRST operand is the SAny one', () => {
    const innerByteColl: SValue = { kind: 'Coll', elem: { tag: 'SByte' }, items: [{ kind: 'Byte', value: 2 }] }
    const expr: Append = {
      tag: 'Append',
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SAny' } },
        value: { kind: 'Coll', elem: { tag: 'SAny' }, items: [] },
      },
      col2: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SByte' } } },
        value: { kind: 'Coll', elem: { tag: 'SColl', elem: { tag: 'SByte' } }, items: [innerByteColl] },
      },
    }
    const ctx = makeContext()
    const result = evalExpr(expr, Env.empty(), ctx)
    expect((result as { elem: unknown }).elem).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
  })

  it('still rejects two concrete but mismatched elem types', () => {
    const expr: Append = {
      tag: 'Append',
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }] },
      },
      col2: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: { kind: 'Coll', elem: { tag: 'SByte' }, items: [{ kind: 'Byte', value: 1 }] },
      },
    }
    const ctx = makeContext()
    expect(() => evalExpr(expr, Env.empty(), ctx)).toThrow(/same elem type/)
  })
})
