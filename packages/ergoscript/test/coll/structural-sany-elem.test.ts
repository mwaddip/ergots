/**
 * A tuple collection is told by the identity of its `elem` object: the one
 * `SANY_JVM` object the `tupleColl` builder places on it
 * (`packages/ergoscript/src/coll/build.ts`). A `kind: 'Coll'` whose `elem` is
 * a structural `{ tag: 'SAny' }` object — not `SANY_JVM` by `===` — is not a
 * tuple collection to the evaluator. The four consequences pinned below
 * mirror the contract paragraph in `packages/ergoscript/API.md` under
 * `tupleColl(items)` and `facts/ergoscript-eval.md` under "Tuples and non-pair
 * tuple values".
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { serializeSValue, SValueSerializeError, tupleItems } from '../../src/wire/serialize-svalue'
import { ByteWriter } from '@ergots/scorex'
import type { CollValue } from '../../src/coll'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

const SINT: SType = { tag: 'SInt' }
const SBOOL: SType = { tag: 'SBoolean' }
const TRIPLE_III: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }

/** A `Coll` whose `elem` is a fresh `{ tag: 'SAny' }` object, structurally
 *  the JVM's `SAny` but not the `SANY_JVM` object by identity. */
function structuralSAnyColl(items: SValue[]): CollValue {
  return {
    kind: 'Coll',
    elem: { tag: 'SAny' },
    items,
    cls: { shape: 'array', specialised: false, array: 'Object' },
  }
}

describe('a Coll whose elem is a structural SAny (not SANY_JVM by identity)', () => {
  it("the value writer refuses with 'type-value-mismatch' (tupleItems returns null)", () => {
    const value = structuralSAnyColl([{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }, { kind: 'Int', value: 3 }])
    expect(tupleItems(value)).toBeNull()
    const w = new ByteWriter()
    expect(() => serializeSValue(TRIPLE_III, value, 3, w)).toThrow(SValueSerializeError)
    try {
      serializeSValue(TRIPLE_III, value, 3, new ByteWriter())
    } catch (e) {
      expect((e as SValueSerializeError).code).toBe('type-value-mismatch')
    }
  })

  it("the HOF element check refuses with 'coll-elem-tpe-mismatch' (Filter arm)", () => {
    const value = structuralSAnyColl([{ kind: 'Int', value: 1 }])
    const COLL_TRIPLE: SType = { tag: 'SColl', elem: TRIPLE_III }
    const input: Expr = { tag: 'Const', tpe: COLL_TRIPLE, value }
    const trueC: Expr = { tag: 'Const', tpe: SBOOL, value: { kind: 'Boolean', value: true } }
    const lam: Expr = { tag: 'FuncValue', args: [{ id: 1, tpe: TRIPLE_III }], body: trueC }
    const expr: Expr = { tag: 'Filter', input, condition: lam }
    const ctx = makeContext({ treeVersion: 3 })
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('coll-elem-tpe-mismatch')
  })

  it("SelectField refuses on a kind:'Coll' of structural SAny ('select-field-input-not-tuple')", () => {
    const value = structuralSAnyColl([{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }])
    const PAIR_II: SType = { tag: 'STuple', items: [SINT, SINT] }
    const input: Expr = { tag: 'Const', tpe: PAIR_II, value }
    const expr: Expr = { tag: 'SelectField', input, fieldIndex: 1 }
    const ctx = makeContext({ treeVersion: 3 })
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    // The arm's class check for a non-pair-value input fires first on a
    // `kind: 'Coll'` ('select-field-input-not-tuple'); the structural SAny
    // never reaches the tupleColl-identity branch ('select-field-non-pair').
    expect(err.code).toBe('select-field-input-not-tuple')
  })

  it("SizeOf still answers (iterates items; no elem-identity test)", () => {
    const value = structuralSAnyColl([
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
      { kind: 'Int', value: 3 },
    ])
    const COLL_TRIPLE: SType = { tag: 'SColl', elem: TRIPLE_III }
    const input: Expr = { tag: 'Const', tpe: COLL_TRIPLE, value }
    const expr: Expr = { tag: 'SizeOf', input }
    const ctx = makeContext({ treeVersion: 3 })
    const v = evalExpr(expr, Env.empty(), ctx)
    expect(v).toEqual({ kind: 'Int', value: 3 })
  })
})
