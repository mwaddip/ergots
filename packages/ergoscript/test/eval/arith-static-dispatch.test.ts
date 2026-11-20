/**
 * An arithmetic node dispatches on its LEFT operand's static type: the JVM's
 * `ArithOp.eval` evaluates the left operand, then the right operand, then
 * calls `companion.eval(this, tpe.typeCode, x, y)` with `tpe = left.tpe`
 * (`data/shared/src/main/scala/sigma/ast/trees.scala:722-728`, `:707`).
 * `ArithOpCompanion.eval` does `ArithOp.impls(typeCode)` FIRST, before any
 * cost is charged (`:733-736`), and `impls` (`:861-869`) has entries for the
 * numeric type codes only. An arith node whose left operand's static type is
 * the JVM's `SAny` (97) or `NoType` (0) has no implementation: the lookup
 * refuses after both operands are evaluated and before any cost of the node.
 *
 * ergots mirrors this in `eval/bin-op/arith.ts`'s `evalArithOp` — a check
 * beside the arm, reading `exprTpe(e.left, treeVersion)` and refusing when it
 * is `SANY_JVM` or `NOTYPE_JVM` by identity (ergots' own `SAny`, a fresh
 * `{ tag: 'SAny' }` object from the method typing, is not refused).
 *
 * Tests on a hand-built `tupleColl` bound to context variable 1 under its
 * tuple type (as `tuple-collection.test.ts` and `tuple-collection-sites.test.ts`
 * do), so they do not depend on the data reader's switch.
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, type EvalContext, EvalError } from '../../src/eval/eval-context'
import { tupleColl } from '../../src/coll'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, plainColl } from '../_helpers'

const SINT: SType = { tag: 'SInt' }
const TRIPLE_III: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }
const COLL_INT: SType = { tag: 'SColl', elem: SINT }

const intConst = (v: number): Expr => ({
  tag: 'Const',
  tpe: SINT,
  value: { kind: 'Int', value: v },
})

const intInt = (v: number): SValue => ({ kind: 'Int', value: v })

function intTupleColl(values: number[]): SValue {
  return tupleColl(values.map((v) => ({ kind: 'Int', value: v }) as SValue))
}

/** `getVar[T](1).get` — reads variable 1 bound by the context. */
const getVarGet = (tpe: SType): Expr => ({
  tag: 'OptionGet',
  input: { tag: 'GetVar', varId: 1, varTpe: tpe },
})

/** `ByIndex(getVar[T](1).get, i)`: typed as the input's `elemType`. For a
 *  non-pair STuple that is the JVM's `SAny` (`SType.scala:838-841`). */
const byIndexOfTupleVar = (tpe: SType, i: number): Expr => ({
  tag: 'ByIndex',
  input: getVarGet(tpe),
  index: intConst(i),
  default: null,
})

/** The seven `ArithOp` opcodes `ArithOp.operations` registers
 *  (`data/shared/src/main/scala/sigma/ast/trees.scala:862`): every one dispatches
 *  through the same `companion.eval` path and the same `ArithOp.impls` lookup. */
type ArithOpName = 'Plus' | 'Minus' | 'Multiply' | 'Divide' | 'Modulo' | 'Min' | 'Max'
const ARITH_OPS: readonly ArithOpName[] = [
  'Plus',
  'Minus',
  'Multiply',
  'Divide',
  'Modulo',
  'Min',
  'Max',
] as const

/** `BinOp.Arith.<op>(left, right)`. */
function arith(op: ArithOpName, left: Expr, right: Expr): Expr {
  return { tag: 'BinOp', op: { kind: 'Arith', op }, left, right }
}

/** The answer each op gives on `left <op> right` for small Int operands,
 *  used by the accept-side table-driven cases. */
function expectedInt(op: ArithOpName, left: number, right: number): number {
  switch (op) {
    case 'Plus': return left + right
    case 'Minus': return left - right
    case 'Multiply': return left * right
    case 'Divide': return Math.trunc(left / right)
    case 'Modulo': return left % right
    case 'Min': return Math.min(left, right)
    case 'Max': return Math.max(left, right)
  }
}

function runWithCost(expr: Expr, varTpe: SType, varVal: SValue, treeVersion = 3) {
  const ctx: EvalContext = makeContext({
    treeVersion,
    extension: { values: new Map([[1, { tpe: varTpe, value: varVal }]]) },
  })
  const value = evalExpr(expr, Env.empty(), ctx)
  return { value, cost: ctx.jitCost }
}

describe('ArithOp.impls lookup — static-type refusal on the LEFT operand', () => {
  // Table-driven over the seven `ArithOp` opcodes `ArithOp.operations`
  // registers (`trees.scala:862`): each one takes the same `companion.eval`
  // path and the same `ArithOp.impls` lookup, so each refuses a left typed
  // as the JVM's `SAny` and answers with an Int left (the SELF index Int 3
  // is small and positive enough for `Divide` and `Modulo` to answer too).
  for (const op of ARITH_OPS) {
    it(`${op} with a ByIndex-of-tuple left operand refuses as 'bin-op-not-numeric'`, () => {
      // ByIndex over a 3-tuple types as the JVM's SAny. ArithOp.impls has no
      // entry for code 97; the lookup throws KeyNotFoundException.
      const expr = arith(op, byIndexOfTupleVar(TRIPLE_III, 0), intConst(3))
      const err = captureEvalError(() =>
        runWithCost(expr, TRIPLE_III, intTupleColl([1, 2, 3])),
      )
      expect(err).toBeInstanceOf(EvalError)
      expect(err.code).toBe('bin-op-not-numeric')
    })

    it(`${op} with an Int left and a ByIndex-of-tuple right answers (dispatch is on the LEFT type)`, () => {
      // Left is SInt (3), in the impls table — the arith runs over the Int
      // from ByIndex(tuple, 0) (= 1) as the right operand. The tuple
      // collection run and a plain Coll[Int] twin pay the same cost.
      const tupleRun = runWithCost(
        arith(op, intConst(3), byIndexOfTupleVar(TRIPLE_III, 0)),
        TRIPLE_III,
        intTupleColl([1, 2, 3]),
      )
      expect(tupleRun.value).toEqual(intInt(expectedInt(op, 3, 1)))

      const twin = runWithCost(
        arith(op, intConst(3), {
          tag: 'ByIndex',
          input: getVarGet(COLL_INT),
          index: intConst(0),
          default: null,
        }),
        COLL_INT,
        plainColl(SINT, [1, 2, 3].map(intInt)),
      )
      expect(twin.value).toEqual(intInt(expectedInt(op, 3, 1)))
      expect(tupleRun.cost).toBe(twin.cost)
    })
  }

  it('order pin: right operand is evaluated before the lookup — a refusing right surfaces its own refusal', () => {
    // `ByIndex(t, 0) + ByIndex(t, 999)` — the right operand's ByIndex goes
    // out of range and throws its own code; the JVM evaluates both operands
    // before the companion.eval impls lookup (trees.scala:722-725), so this
    // throw reaches the caller first.
    const rightOutOfRange: Expr = {
      tag: 'ByIndex',
      input: getVarGet(TRIPLE_III),
      index: intConst(999),
      default: null,
    }
    const expr = arith('Plus', byIndexOfTupleVar(TRIPLE_III, 0), rightOutOfRange)
    const err = captureEvalError(() =>
      runWithCost(expr, TRIPLE_III, intTupleColl([1, 2, 3])),
    )
    // The right's own refusal (ByIndex out of range) surfaces, NOT the arith
    // static-type refusal (which would have been `'bin-op-not-numeric'`).
    expect(err.code).toBe('coll-by-index-out-of-range')
  })

  it("ergots' own SAny on the left is not refused (the identity check is against SANY_JVM)", () => {
    // Build a lambda whose range types as ergots' own `{ tag: 'SAny' }` (via
    // an unresolved method call return type), feed its result as the left
    // operand of Plus. The static check reads SANY identity: a fresh
    // ergots-SAny object passes, and the arith proceeds by runtime kind.
    //
    // Simpler path: a bare `ValUse` typed as `SAny` (ergots' own; a new
    // object literal) passes the static check. We can't reach this from a
    // parsed tree, but a hand-built MIR exercises the code path.
    const OWN_SAny: SType = { tag: 'SAny' } // a fresh object, not SANY_JVM
    const valUseAny: Expr = { tag: 'ValUse', valId: 1, tpe: OWN_SAny }
    const blockWithOwnSAny: Expr = {
      tag: 'BlockValue',
      items: [
        {
          tag: 'ValDef',
          id: 1,
          tpeArgs: [],
          rhs: { tag: 'Const', tpe: SINT, value: intInt(1) },
        },
      ],
      result: arith('Plus', valUseAny, intConst(2)),
    }
    // Runtime kind of the valUse is Int (the ValDef evaluates to Int 1); the
    // static-check reads OWN_SAny which is not SANY_JVM by identity, so the
    // arith proceeds and returns Int 3.
    const ctx: EvalContext = makeContext({ treeVersion: 3 })
    const value = evalExpr(blockWithOwnSAny, Env.empty(), ctx)
    expect(value).toEqual(intInt(3))
  })
})
