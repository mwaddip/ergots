/**
 * ExtractAmount arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_amount.rs:9-25
 *   ctx.add_jit_cost(8)?;                            // BEFORE eval-child
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v { Value::CBox(b) => Value::Long(b.value.as_i64()), ... }
 *
 * Fixed(8) cost charged BEFORE eval-child (Pattern A — envelope-first).
 * Const(SBox) arm charges Fixed(5); total fixture cost = 13.
 *
 * Coverage:
 *   - Box with value=BoxValue::MIN_RAW (10800 nanoErg).
 *   - Box with value=1_000_000_000 (1 ERG).
 *   - Box with value=i64::MAX (BoxValue::MAX_RAW).
 *   - Randomized self_box from force_any_val::<Context>() (deterministic).
 *   - 1 cost-limit entry (jitCostLimit=1 < Fixed(8)) → 'cost-limit-exceeded'.
 *
 * The non-Box error path ('extract-input-not-box') cannot be triggered via
 * sigma-rust fixtures — ExtractAmount::try_build rejects non-SBox inputs at
 * construction time. Inline tests below construct hand-built MIR nodes that
 * bypass the parser and exercise the defensive kind-check directly.
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
import type { ExtractAmount } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/extract-amount.json')

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

describe('ExtractAmount arm — fixture-driven', () => {
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

describe('ExtractAmount arm — defensive kind-check', () => {
  it('throws extract-input-not-box when input is not a Box', () => {
    // Hand-built MIR node bypassing sigma-rust's try_build SBox-type check.
    const expr: ExtractAmount = {
      tag: 'ExtractAmount',
      input: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 5 },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('extract-input-not-box')
  })

  it('throws extract-input-not-box when input is a Long (not a Box)', () => {
    const expr: ExtractAmount = {
      tag: 'ExtractAmount',
      input: {
        tag: 'Const',
        tpe: { tag: 'SLong' },
        value: { kind: 'Long', value: 42n },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('extract-input-not-box')
  })
})
