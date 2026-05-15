/**
 * XorOf arm — fixture-driven + inline defensive tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/xor_of.rs:12-36
 *   let input_v = self.input.eval(env, ctx)?;
 *   let input_v_bools = input_v.try_extract_into::<Vec<bool>>()?;
 *   ctx.add_per_item_jit_cost(20, 5, 32, input_v_bools.len() as u32)?;
 *   if ctx.tree_version() < V2 {
 *       // JVM v4.x bug: hasTrue && hasFalse (count-independent)
 *   } else {
 *       // Correct left-fold XOR: true iff odd count of trues
 *   }
 *
 * Reads ctx.treeVersion ?? 0 to discriminate V0/V1 (JVM v4.x bug) vs
 * V2+ (correct XOR). Cost identical at both branches.
 *
 * Smoking-gun case: xorOf([true, true, false]) → true at V0/V1 (bug),
 * → false at V2+ (correct XOR; 2 trues = even count).
 *
 * Cost-charging order: AFTER eval-child (Cast pattern matching slice B's
 * And/Or arms per sigma-rust xor_of.rs:20).
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
import type { XorOf } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/xor-of.json')

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

describe('XorOf arm — fixture-driven', () => {
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

describe('XorOf arm — defensive', () => {
  it('throws coll-not-boolean when input is not a Coll', () => {
    const expr: XorOf = {
      tag: 'XorOf',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-not-boolean')
  })

  it('throws coll-not-boolean when Coll items are not Boolean', () => {
    const expr: XorOf = {
      tag: 'XorOf',
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
  })
})
