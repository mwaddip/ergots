/**
 * ExtractBytesWithNoRef arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_bytes_with_no_ref.rs:9-25
 *   ctx.add_jit_cost(12)?;                           // BEFORE eval-child
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v { Value::CBox(b) => Ok(b.bytes_without_ref()?.into()), ... }
 *
 * Fixed(12) cost charged BEFORE eval-child (Pattern A — envelope-first).
 * Const(SBox) arm charges Fixed(5); total fixture cost = 17.
 *
 * `b.bytes_without_ref()` returns box bytes WITHOUT tx_id and index:
 *   value + ergoTree + creation_height + tokens + registers
 * Reflected in TS by `serializeBoxBytesWithoutRef(box)` → `bytesToCollByteSValue(bytes)`.
 *
 * Coverage (4 fixture entries):
 *   - minimal: no tokens, no registers — expected bytes are 10 shorter than full form
 *   - tokens: 3 tokens, no registers
 *   - registers: R4+R5 populated, no tokens
 *   - cost_limit: jitCostLimit=1 < Fixed(12) → 'cost-limit-exceeded'
 *
 * Error path ('extract-input-not-box') exercised inline below.
 * Cannot trigger via sigma-rust fixtures — ExtractBytesWithNoRef::try_build rejects
 * non-SBox inputs at construction time.
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
import type { ExtractBytesWithNoRef } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(
  __dirname,
  '../fixtures/eval/extract-bytes-with-no-ref.json'
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

describe('ExtractBytesWithNoRef arm — fixture-driven', () => {
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

describe('ExtractBytesWithNoRef arm — defensive kind-check', () => {
  it('throws extract-input-not-box when input is not a Box', () => {
    // Hand-built MIR node bypassing sigma-rust's try_build SBox-type check.
    const expr: ExtractBytesWithNoRef = {
      tag: 'ExtractBytesWithNoRef',
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
    const expr: ExtractBytesWithNoRef = {
      tag: 'ExtractBytesWithNoRef',
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
