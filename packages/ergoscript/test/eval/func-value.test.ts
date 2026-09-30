/**
 * FuncValue arm — inline tests (no fixture file).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/func_value.rs:10-18
 *   ctx.add_jit_cost(5)?; // FuncValue = Fixed(5)
 *   Ok(Value::Lambda(Lambda { args: self.args().to_vec(), body: self.body().clone().into() }))
 *
 * Lambda values aren't directly serializable via fixture-gen's
 * value_to_json helper. Tests construct a FuncValue MIR node by hand,
 * eval it, and assert SValue.kind === 'Lambda' + closure structure.
 * A FuncValue of other than one parameter rejects instead, as the JVM's
 * does (values.scala:1070-1085): the probed spends are below.
 *
 * Cost-charging: Fixed(5) BEFORE the arity check and before returning the
 * Lambda (sigma-rust line 12; the JVM's FuncValue.eval charges first too).
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { evaluateWith } from '../../src/eval/evaluate'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { FuncValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, parseParsedTree } from '../_helpers'

describe('FuncValue arm — inline', () => {
  it('returns Lambda SValue with cost 5', () => {
    const expr: FuncValue = {
      tag: 'FuncValue',
      args: [{ id: 1, tpe: { tag: 'SInt' } }],
      body: {
        tag: 'ValUse',
        valId: 1,
        tpe: { tag: 'SInt' },
      },
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value.kind).toBe('Lambda')
    if (value.kind === 'Lambda') {
      expect(value.closure.argIds).toEqual([1])
      expect(value.closure.body).toEqual(expr.body)
      // capturedEnv is the lexical env at definition (here Env.empty(), the env
      // the FuncValue was evaluated in) — v6 lexical scoping (closures), JVM-
      // faithful. The body is later evaluated in this captured env extended
      // with arg bindings, not the apply-site env.
      expect(value.closure.capturedEnv).toEqual(Env.empty())
    }
    expect(ctx.jitCost).toBe(5)
  })

  it('a two-argument lambda is charged its 5, then rejected: no closure (the JVM, values.scala:1070-1085)', () => {
    // Until 2026-09-30 this test expected a Lambda with argIds [1, 2], sigma-rust's behavior. The JVM's FuncValue.eval
    // builds a closure for exactly one argument (a local sigma-state 6.0.6 probe: every spend below that evaluates one of
    // another arity rejects with "Function must have 1 argument").
    const expr: FuncValue = {
      tag: 'FuncValue',
      args: [
        { id: 1, tpe: { tag: 'SInt' } },
        { id: 2, tpe: { tag: 'SBoolean' } },
      ],
      body: { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } },
    }
    const ctx = makeContext()
    expect(captureEvalError(() => evalExpr(expr, Env.empty(), ctx)).code).toBe('apply-arity-mismatch')
    expect(ctx.jitCost).toBe(5)
  })
})

// ── A FuncValue with other than one argument (spec §9; the final fix round's addendum) ─────────────────────────────
// The JVM's FuncValue.eval charges its cost (5), then builds a closure only for exactly one parameter, and otherwise
// throws "Function must have 1 argument" (values.scala:1070-1085). So a lambda of 0, 2 or more parameters rejects the
// spend wherever it is evaluated: passed to map, exists, forall or filter, compared with ==, or bound. ergots built a
// closure for any arity, an over-accept master has too. The code is 'apply-arity-mismatch', the one Apply's own
// one-argument rule throws. Each row is a local sigma-state 6.0.6 probe spend (the tree parsed by the box rules, R4
// absent): a reject is an InterpreterException, "Function must have 1 argument"; an accept is TrueProp at the probe's
// block cost (the JIT cost ÷ 10). The ergots verdict before this change is noted where it differed.
describe('a FuncValue with other than one argument rejects when evaluated, as the JVM does (values.scala:1070-1085)', () => {
  type Row = { name: string; version: number; hex: string; accept?: { blockCost: number } }
  const ROWS: Row[] = [
    // F1-F5: accepted before, as TrueProp.
    { name: 'F1 Coll[Int]().map((a, b) => a).size == 0', version: 0, hex: '00d193b1ad1000d9020104020472010400' },
    { name: 'F1 at v3', version: 3, hex: '0b10d193b1ad1000d9020104020472010400' },
    { name: 'F2 Coll(5).map((a, b) => a).size == 1', version: 0, hex: '00d193b1ad10010ad9020104020472010402' },
    { name: 'F3 Coll(5).exists((a, b) => true)', version: 0, hex: '00d1ae10010ad902010402040101' },
    { name: 'F4 Coll[Int]().forall((a, b) => true)', version: 0, hex: '00d1af1000d902010402040101' },
    { name: 'F5 Coll(5).filter((a, b) => true).size == 1', version: 0, hex: '00d193b1b510010ad9020104020401010402' },
    // F6: rejected before, by the exists arm ('lambda-not-callable'); now by the FuncValue, before the call.
    { name: 'F6 Coll(5).exists(() => true)', version: 0, hex: '00d1ae10010ad9000101' },
    // F7, F9: reduced to false before.
    { name: 'F7 ((a, b) => a) == ((a, b) => a)', version: 0, hex: '00d193d902010402047201d902010402047201' },
    { name: 'F9 (() => true) == (() => true)', version: 0, hex: '00d193d9000101d9000101' },
    // F10, F11: rejected before, at the binding ('unsupported-value-type'); now by the FuncValue, before the binding.
    { name: 'F10 { val f = () => 5; true }', version: 0, hex: '00d801d601d900040ad10101' },
    { name: 'F11 { val f = (a, b) => a; true }', version: 0, hex: '00d801d601d902010402047201d10101' },
    // The controls: never evaluated, or one parameter.
    { name: 'F8 F2 in a branch never evaluated', version: 0, hex: '00d195010093b1ad10010ad90201040204720104020101', accept: { blockCost: 3 } },
    { name: 'F12 Coll(5).map((a) => a).size == 1', version: 0, hex: '00d193b1ad10010ad901010472010402', accept: { blockCost: 7 } },
    { name: 'F13 { val f = (a) => a; true }', version: 0, hex: '00d801d601d90101047201d10101', accept: { blockCost: 3 } },
    { name: 'F14 Coll(5).exists((a) => true)', version: 0, hex: '00d1ae10010ad90101040101', accept: { blockCost: 3 } },
  ]
  for (const row of ROWS) {
    const verdict = row.accept ? `TrueProp at ${row.accept.blockCost} block units` : 'rejects'
    it(`${row.name} (v${row.version}): the JVM ${verdict}`, () => {
      const tree = parseParsedTree(hexToBytes(row.hex))
      expect(tree.header.version).toBe(row.version)
      const ctx = makeContext()
      if (row.accept === undefined) {
        expect(captureEvalError(() => evaluateWith(tree, ctx)).code).toBe('apply-arity-mismatch')
        return
      }
      expect(evaluateWith(tree, ctx)).toEqual({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } })
      expect(Math.floor(ctx.jitCost / 10)).toBe(row.accept.blockCost)
    })
  }

  const funcValue = (arity: number): FuncValue => ({
    tag: 'FuncValue',
    args: Array.from({ length: arity }, (_, i) => ({ id: i + 1, tpe: { tag: 'SInt' } })),
    body: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
  })
  for (const arity of [0, 2, 3]) {
    it(`${arity} parameters: charged the FuncValue's 5, then rejected`, () => {
      const ctx = makeContext()
      expect(captureEvalError(() => evalExpr(funcValue(arity), Env.empty(), ctx)).code).toBe('apply-arity-mismatch')
      expect(ctx.jitCost).toBe(5)
    })
  }
  it('the cost comes first: under a limit below 5 the charge trips before the arity check', () => {
    const ctx = makeContext({ jitCostLimit: 4 })
    expect(captureEvalError(() => evalExpr(funcValue(2), Env.empty(), ctx)).code).toBe('cost-limit-exceeded')
  })
})
