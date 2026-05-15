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
 * Two new defensive EvalError codes:
 *   - 'apply-non-lambda': Apply.func evaluated to non-Lambda
 *   - 'apply-arity-mismatch': closure.argIds.length !== e.args.length
 *     (checked BEFORE arg-eval; pure structural)
 *
 * Inline defensive tests use hand-built MIR nodes to exercise both
 * defensive paths.
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
import type { Apply } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

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
