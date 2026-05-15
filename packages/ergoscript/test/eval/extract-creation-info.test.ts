/**
 * ExtractCreationInfo arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_creation_info.rs:9-25
 *   ctx.add_jit_cost(16)?;                          // BEFORE eval-child (Pattern A)
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v { Value::CBox(b) => Ok(b.creation_info().into()), ... }
 *
 * Fixed(16) cost charged BEFORE eval-child (Pattern A — envelope-first).
 * Const(SBox) arm charges Fixed(5); total fixture cost = 21.
 *
 * `creation_info` returns (creation_height as i32, bytes) where:
 *   bytes = txId (32 bytes) ++ index.to_be_bytes() (2 bytes; u16 BE) = 34 bytes total.
 * Return type: STuple[SInt, SColl[SByte]].
 *
 * Coverage (5 fixture entries):
 *   - default box: height=0, all-zero txId, index=0
 *   - realistic: height=12345, patterned txId, index=3
 *   - max_index: index=65535 (u16 max; BE bytes -1/-1 in signed i8)
 *   - high_height: creation_height=1_000_000_000
 *   - cost_limit: jitCostLimit=1 < Fixed(16) → 'cost-limit-exceeded'
 *
 * Error path ('extract-input-not-box') tested inline below.
 * Cannot trigger via sigma-rust fixtures — ExtractCreationInfo::try_build
 * rejects non-SBox inputs at construction time (same as ExtractScriptBytes).
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
import type { ExtractCreationInfo } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(
  __dirname,
  '../fixtures/eval/extract-creation-info.json'
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

describe('ExtractCreationInfo arm — fixture-driven', () => {
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

describe('ExtractCreationInfo arm — extract-input-not-box guard', () => {
  it('throws extract-input-not-box when input is not a Box', () => {
    // Hand-built MIR node bypassing sigma-rust's try_build SBox-type check.
    // sigma-rust ExtractCreationInfo::try_build rejects non-SBox at construction time;
    // the TS wire parser doesn't type-check, so this tests the eval guard.
    const expr: ExtractCreationInfo = {
      tag: 'ExtractCreationInfo',
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
    const expr: ExtractCreationInfo = {
      tag: 'ExtractCreationInfo',
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
