/**
 * `Append` arm — outputs and refusals under the JVM's rule.
 *
 * Source: `data/shared/src/main/scala/sigma/ast/transformers.scala:59-70`
 * and `core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:48-57`
 * at sigma-state 6.0.7.
 *
 * The three cases below rest on the module's `append`:
 *   - A concrete `Coll[Coll[SByte]]` receiver appended with an empty
 *     `Coll[SAny]` operand reads as `Coll[Coll[SByte]].append(Coll[Object])`.
 *     The receiver has one item (non-empty), so `safeConcatArrays_v5`
 *     allocates a new reference array of the receiver's class tag
 *     (`'Coll'`), and `System.arraycopy` from an empty Object-reference
 *     source does nothing — no exception. The result's class and `elem`
 *     come from the receiver.
 *   - An empty `Coll[SAny]` receiver appended with a `Coll[Coll[SByte]]`
 *     operand returns the operand UNREAD (`CollsOverArrays.scala:49`), so
 *     the result's `elem` is `Coll[SByte]`.
 *   - Two concrete but mismatched element types: `Coll[SInt]` (plain int
 *     array, non-empty) appended with `Coll[SByte]`: `safeConcatArrays_v5`
 *     allocates `new Array[Int]` and `System.arraycopy` from an
 *     `Array[Byte]` source fails the component-type check upfront. The
 *     module raises `CollArrayStore`, the facade turns it into
 *     `EvalError('coll-array-store')`.
 */

import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Append, SValue } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

describe('Append — the module applies the JVM rule', () => {
  it('concrete Coll[Coll[SByte]] appended with an empty Coll[SAny] returns the receiver`s elem', () => {
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
    // Output elem comes from the non-empty input (the receiver), not SAny.
    expect((result as { elem: unknown }).elem).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
    expect((result as { items: unknown[] }).items).toHaveLength(1)
  })

  it('empty receiver returns the operand UNREAD — its own elem', () => {
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

  it('a Coll[SInt] appended with a Coll[SByte]: coll-array-store (CollOverArray.append → safeConcatArrays_v5 refuses the source component type)', () => {
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
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-array-store')
  })
})
