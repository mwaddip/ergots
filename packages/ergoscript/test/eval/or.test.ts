/**
 * Or arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/or.rs:11-22
 *   let input_v = self.input.eval(env, ctx)?;
 *   let input_v_bools = input_v.try_extract_into::<Vec<bool>>()?;
 *   ctx.add_per_item_jit_cost(5, 5, 64, input_v_bools.len() as u32)?;
 *   Ok(input_v_bools.iter().any(|b| *b).into())
 *
 * Reduces a Coll[Boolean] to Boolean via any-true (`some`). Empty
 * Coll returns false (identity of Or).
 *
 * Cost-charging order: AFTER eval-child. `addPerItemCost(5, 5, 64, n)`
 * — base 5 (not 10), chunkSize 64 (not 32). Distinct from And's cost.
 *
 * Coverage:
 *   - Empty Coll[Boolean] → false (identity of Or).
 *   - Single-item / all-true / all-false / mixed.
 *   - Chunk boundaries at n=64 (one chunk) and n=65 (two chunks).
 *   - 1 cost-limit entry → `'cost-limit-exceeded'`.
 *
 * The non-Coll[Boolean] failure path can't be triggered via sigma-rust
 * (parser enforces `post_eval_tpe == Coll[Boolean]`). Inline tests
 * below construct hand-built MIR nodes that bypass the parser — they
 * test the defensive kind-check in evalOr directly.
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
import type { Or } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/or.json')

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

describe('Or arm — fixture-driven', () => {
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

describe('Or arm — defensive kind-check', () => {
  it('throws coll-not-boolean when input is not a Coll', () => {
    const expr: Or = {
      tag: 'Or',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: false },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-not-boolean')
  })

  it('throws coll-not-boolean when Coll items are not Boolean', () => {
    const expr: Or = {
      tag: 'Or',
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SInt' },
          items: [
            { kind: 'Int', value: 1 },
            { kind: 'Int', value: 2 },
          ],
        },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-not-boolean')
    expect(err.message).toContain('item 0')
  })
})
