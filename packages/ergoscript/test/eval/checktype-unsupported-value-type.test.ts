/**
 * checkType class (F5 batch 3) — `'unsupported-value-type'` reject.
 *
 * The JVM rejects values whose DECLARED type is a non-pair `STuple` (arity ≠ 2)
 * or a non-unary `SFunc` (arity ≠ 1): `SType.isValueOfType` (SType.scala:200-205)
 * `sys.error`s "Unsupported tuple type"/"Unsupported function type" — it cannot
 * represent such values. `Value.checkType(node, x)` (values.scala:251-254) runs
 * this against `node.tpe` at the value-flow seams after evaluating children.
 *
 * ergots mirrors via `assertValueTypeSupported(tpe)` (eval/_check-type.ts),
 * called at the data seams: Tuple items (values.scala:801,804), ConstantPlaceholder
 * (values.scala:412), ConcreteCollection items, BlockValue (valdef rhs + result),
 * ValUse. Top-level only (non-recursive — matches the JVM single isValueOfType
 * call; nesting is covered by the per-seam calls).
 *
 * Laziness: the check fires only when the seam is ACTUALLY evaluated (hooked
 * inside the eval arms, NOT a whole-tree pre-eval pass), so a non-pair-tuple-
 * typed const in a DEAD branch does NOT reject — matching JVM lazy eval.
 *
 * Two JVM-blessed witnesses (both expect ERRORED):
 *   W1 008602480101010101010402            — Tuple(Const((Bool,Bool,Bool)), Int(1))
 *   W2 1002480101010101010402860273007301  — Tuple(CP(0,(Bool,Bool,Bool)), CP(1,SInt))
 */
import { describe, it, expect } from 'vitest'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { Expr, SType } from '../../src/mir/types'
import { captureEvalError, hexToBytes, parseParsedTree as parseTree } from '../_helpers'

// (Bool,Bool,Bool) — a non-pair (3-ary) tuple TYPE.
const TRIPLE: SType = {
  tag: 'STuple',
  items: [{ tag: 'SBoolean' }, { tag: 'SBoolean' }, { tag: 'SBoolean' }],
}
// A runtime Tuple value of that type (3 booleans).
const TRIPLE_VALUE = {
  kind: 'Tuple' as const,
  items: [
    { kind: 'Boolean' as const, value: true },
    { kind: 'Boolean' as const, value: true },
    { kind: 'Boolean' as const, value: true },
  ],
}
// Const node whose DECLARED type is the non-pair triple.
const TRIPLE_CONST: Expr = { tag: 'Const', tpe: TRIPLE, value: TRIPLE_VALUE }
const INT_CONST: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } }

describe('checkType class — JVM-blessed witnesses', () => {
  it('W1: Tuple item with non-pair-STuple declared type → unsupported-value-type', () => {
    // 008602480101010101010402 — Tuple( Const((Bool,Bool,Bool)), Int(1) ).
    // The outer Tuple is a valid PAIR; the violation is item0's declared TYPE.
    const tree = parseTree(hexToBytes('008602480101010101010402'))
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('unsupported-value-type')
  })

  it('W2: ConstantPlaceholder with non-pair-STuple declared type → unsupported-value-type', () => {
    // 1002480101010101010402860273007301 — Tuple( CP(0,(Bool,Bool,Bool)), CP(1,SInt) ).
    const tree = parseTree(hexToBytes('1002480101010101010402860273007301'))
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('unsupported-value-type')
  })
})

describe('checkType class — positive controls (must NOT over-reject)', () => {
  it('a valid PAIR tuple (Bool, Int) still evaluates', () => {
    // 00860201010207 — Tuple( true, 7.toByte ) — the existing arity-2 regression.
    const tree = parseTree(hexToBytes('00860201010207'))
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({
      kind: 'Tuple',
      items: [
        { kind: 'Boolean', value: true },
        { kind: 'Byte', value: 7 },
      ],
    })
  })

  it('a pair tuple whose items are themselves valid pairs evaluates', () => {
    // Tuple( (Int,Int), (Bool,Int) ) — both items are 2-ary STuple values; legal.
    const pairII: Expr = {
      tag: 'Const',
      tpe: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }] },
      value: { kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }] },
    }
    const pairBI: Expr = {
      tag: 'Const',
      tpe: { tag: 'STuple', items: [{ tag: 'SBoolean' }, { tag: 'SInt' }] },
      value: { kind: 'Tuple', items: [{ kind: 'Boolean', value: true }, { kind: 'Int', value: 9 }] },
    }
    const expr: Expr = { tag: 'Tuple', items: [pairII, pairBI] }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value.kind).toBe('Tuple')
  })
})

describe('checkType class — laziness (dead branch must NOT reject)', () => {
  it('non-pair-tuple-typed Const in an unevaluated If branch does NOT reject', () => {
    // If(false, Tuple(<non-pair const>, Int), safe Int).
    // The non-pair seam lives in the DEAD true-branch; the JVM never evaluates
    // it (lazy), so neither do we — result is the false-branch value.
    const deadTuple: Expr = { tag: 'Tuple', items: [TRIPLE_CONST, INT_CONST] }
    const expr: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: false } },
      trueBranch: deadTuple,
      falseBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 42 })
  })
})

describe('checkType class — per-seam unit coverage', () => {
  it('ConcreteCollection item with non-pair-STuple declared type rejects', () => {
    // Coll[(Bool,Bool,Bool)] with one item: the item's declared type is non-pair.
    const expr: Expr = {
      tag: 'Collection',
      kind: 'Exprs',
      elemTpe: TRIPLE,
      items: [TRIPLE_CONST],
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('BlockValue valdef rhs with non-pair-STuple declared type rejects', () => {
    // { val v0 = <non-pair const>; 1 } — the valdef rhs hits the seam.
    const expr: Expr = {
      tag: 'BlockValue',
      items: [{ tag: 'ValDef', id: 0, rhs: TRIPLE_CONST }],
      result: INT_CONST,
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('BlockValue result with non-pair-STuple declared type rejects', () => {
    // { val v0 = 1; <non-pair const> } — the result expr hits the seam.
    const expr: Expr = {
      tag: 'BlockValue',
      items: [{ tag: 'ValDef', id: 0, rhs: INT_CONST }],
      result: TRIPLE_CONST,
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('ValUse with non-pair-STuple declared type rejects', () => {
    // A ValUse whose declared tpe is the non-pair triple. The env binds a value
    // (so the unbound path is not taken); the seam fires on the declared tpe.
    const expr: Expr = { tag: 'ValUse', valId: 0, tpe: TRIPLE }
    const ctx = makeContext()
    const env = Env.empty().extend(0, TRIPLE_VALUE)
    const err = captureEvalError(() => evalExpr(expr, env, ctx))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('non-unary SFunc declared type flowing through a data seam rejects', () => {
    // No SFunc witness exists on-chain, but the helper must still reject a
    // non-unary SFunc VALUE flowing through a data seam. Use a ConcreteCollection
    // item whose declared type is a 2-arg SFunc ((Int,Int) => Int).
    const twoArgFunc: SType = {
      tag: 'SFunc',
      args: [{ tag: 'SInt' }, { tag: 'SInt' }],
      result: { tag: 'SInt' },
      tpeParams: [],
    }
    // The runtime value is opaque to the seam (the check is on declared tpe),
    // so any SValue works; use a Lambda-shaped placeholder via a Const cast.
    const funcConst: Expr = {
      tag: 'Const',
      tpe: twoArgFunc,
      // value kind is irrelevant to the declared-type check; supply an Int.
      value: { kind: 'Int', value: 0 },
    }
    const expr: Expr = {
      tag: 'Collection',
      kind: 'Exprs',
      elemTpe: twoArgFunc,
      items: [funcConst],
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('a unary SFunc (Int => Int) declared type does NOT reject', () => {
    // Positive control for the SFunc branch: arity-1 is representable.
    const unaryFunc: SType = {
      tag: 'SFunc',
      args: [{ tag: 'SInt' }],
      result: { tag: 'SInt' },
      tpeParams: [],
    }
    const expr: Expr = { tag: 'ValUse', valId: 0, tpe: unaryFunc }
    const ctx = makeContext()
    const env = Env.empty().extend(0, { kind: 'Int', value: 0 })
    // Must not throw 'unsupported-value-type'; ValUse returns the bound value.
    const value = evalExpr(expr, env, ctx)
    expect(value).toEqual({ kind: 'Int', value: 0 })
  })
})
