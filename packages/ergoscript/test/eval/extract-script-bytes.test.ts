/**
 * ExtractScriptBytes arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_script_bytes.rs:9-25
 *   ctx.add_jit_cost(10)?;                           // BEFORE eval-child
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v { Value::CBox(b) => b.script_bytes()?.into(), ... }
 *
 * Fixed(10) cost charged BEFORE eval-child (Pattern A — envelope-first).
 * Const(SBox) arm charges Fixed(5); total fixture cost = 15.
 *
 * Coverage:
 *   - Box with minimal v1 tree (Const(SBoolean true) — small ergoTreeBytes).
 *   - Box with P2PK ProveDlog tree (~35 bytes; realistic on-chain type).
 *   - Box with larger If expression tree.
 *   - Box with segregated-constants tree (hasConstants=true header bit).
 *   - 1 cost-limit entry (jitCostLimit=1 < Fixed(10)) → 'cost-limit-exceeded'.
 *
 * The non-Box error path ('extract-input-not-box') cannot be triggered via
 * sigma-rust fixtures — ExtractScriptBytes::try_build rejects non-SBox inputs at
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
import type { ExtractScriptBytes } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(
  __dirname,
  '../fixtures/eval/extract-script-bytes.json'
)

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

describe('ExtractScriptBytes arm — fixture-driven', () => {
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

describe('ExtractScriptBytes arm — defensive kind-check', () => {
  it('throws extract-input-not-box when input is not a Box', () => {
    // Hand-built MIR node bypassing sigma-rust's try_build SBox-type check.
    const expr: ExtractScriptBytes = {
      tag: 'ExtractScriptBytes',
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

  it('throws extract-input-not-box when input is a Boolean (not a Box)', () => {
    const expr: ExtractScriptBytes = {
      tag: 'ExtractScriptBytes',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('extract-input-not-box')
  })
})
