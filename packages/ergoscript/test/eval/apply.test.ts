/**
 * Apply arm — fixture-driven + inline defensive tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/apply.rs:12-56
 *   ctx.add_jit_cost(30)?; // Apply = Fixed(30) — BEFORE eval-func
 *   let func_v = self.func.eval(env, ctx)?;
 *   match func_v {
 *       Value::Lambda(fv) => { env extend with args; fv.body.eval; }
 *       _ => Err(...)
 *   }
 *
 * Cost-charging order: envelope BEFORE eval-func (sigma-rust line 18).
 *
 * Our TS Env is immutable per phase 2b — Apply uses Env.extend()
 * directly without save/restore. Sigma-rust's mutable save/restore is a
 * borrow-checker workaround that doesn't apply to TS.
 *
 * Two EvalError codes:
 *   - 'apply-non-lambda': Apply.func evaluated to non-Lambda
 *   - 'apply-arity-mismatch': e.args.length !== 1, the JVM's own rule
 *     (values.scala:1262-1272; after Apply's 30, before the function or any
 *     argument is evaluated), or closure.argIds.length !== e.args.length
 *     (checked BEFORE arg-eval; pure structural)
 *
 * Inline defensive tests use hand-built MIR nodes to exercise both
 * defensive paths; the JVM's one-argument rule has its probed spends below.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import type { Apply, Expr } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue, parseParsedTree } from '../_helpers'
import { int } from '../_helpers/mir-build'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/apply.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('Apply arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})

describe('Apply arm — defensive', () => {
  it('throws apply-non-lambda when func is not a Lambda', () => {
    const expr: Apply = {
      tag: 'Apply',
      func: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 42 },
      },
      args: [
        {
          tag: 'Const',
          tpe: { tag: 'SInt' },
          value: { kind: 'Int', value: 1 },
        },
      ],
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('apply-non-lambda')
  })

  it('throws apply-arity-mismatch when arg count differs', () => {
    // Build a FuncValue with 1 arg; Apply it with 2 args.
    const expr: Apply = {
      tag: 'Apply',
      func: {
        tag: 'FuncValue',
        args: [{ id: 1, tpe: { tag: 'SInt' } }],
        body: { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } },
      },
      args: [
        {
          tag: 'Const',
          tpe: { tag: 'SInt' },
          value: { kind: 'Int', value: 1 },
        },
        {
          tag: 'Const',
          tpe: { tag: 'SInt' },
          value: { kind: 'Int', value: 2 },
        },
      ],
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('apply-arity-mismatch')
  })
})

// ── Apply with other than one argument (spec §9; the final review, M2) ─────────────────────────────────────────────
// The JVM's Apply.eval charges Apply's cost, 30, and then throws "Function application must have 1 argument" unless it
// has exactly one argument, before it evaluates the function or any argument (values.scala:1262-1272). ergots applied a
// lambda of the matching arity with any number of arguments, an over-accept master has too. Each row is a local
// sigma-state 6.0.6 probe spend (the tree parsed by the box rules, R4 absent): a reject is an InterpreterException,
// "Function application must have 1 argument"; an accept is TrueProp at the probe's block cost (the JIT cost ÷ 10).
// The fixture's apply_multi_arg_first and apply_multi_arg_second (test/fixtures/eval/apply.json) are two-argument
// applications too: generated from sigma-rust, which applies them, they expect the JVM's reject since 2026-09-30 (the
// probe: each, under sigmaProp(_ == 10) and sigmaProp(_ == 20), the same InterpreterException).
describe('Apply with other than one argument rejects, as the JVM does (values.scala:1262-1272)', () => {
  type Row = { name: string; version: number; hex: string; accept?: { blockCost: number } }
  const ROWS: Row[] = [
    { name: 'the witness, ((a, b) => a + b)(3, 4) == 7', version: 0, hex: '00d193dad902020403049a720272030204060408040e' },
    { name: 'the witness at v3', version: 3, hex: '0b15d193dad902020403049a720272030204060408040e' },
    { name: 'a zero-argument lambda applied to none, (() => 7)() == 7', version: 0, hex: '00d193dad900040e00040e' },
    { name: 'the one-argument control, ((x) => x + 1)(3) == 4', version: 0, hex: '00d193dad90102049a720204020104060408', accept: { blockCost: 9 } },
    {
      name: 'the witness in a branch never evaluated',
      version: 0,
      hex: '00d195010093dad902020403049a720272030204060408040e0101',
      accept: { blockCost: 3 },
    },
    { name: 'the zero-argument case in a branch never evaluated', version: 0, hex: '00d195010093dad900040e00040e0101', accept: { blockCost: 3 } },
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

  // The order: Apply's 30, then the argument count, before the function or any argument is evaluated. A division by
  // zero there would throw its own code if it were evaluated.
  const divZero: Expr = { tag: 'BinOp', op: { kind: 'Arith', op: 'Divide' }, left: int(1), right: int(0) }
  for (const n of [0, 2, 3]) {
    it(`${n} arguments: charged Apply's 30, and neither the function nor an argument is evaluated`, () => {
      const ctx = makeContext()
      const expr: Apply = { tag: 'Apply', func: divZero, args: Array.from({ length: n }, () => divZero) }
      expect(captureEvalError(() => evalExpr(expr, Env.empty(), ctx)).code).toBe('apply-arity-mismatch')
      expect(ctx.jitCost).toBe(30)
    })
  }
  it('one argument: the function is evaluated (the control)', () => {
    const expr: Apply = { tag: 'Apply', func: divZero, args: [int(1)] }
    expect(captureEvalError(() => evalExpr(expr, Env.empty(), makeContext())).code).toBe('arith-divide-by-zero')
  })
})
