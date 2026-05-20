/**
 * LongToByteArray arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/long_to_byte_array.rs:11-25
 *   ctx.add_jit_cost(17)?;                            // Pattern A: BEFORE eval-child
 *   let mut val = self.input.eval(env, ctx)?.try_extract_into::<i64>()?;
 *   // pack to 8 bytes big-endian
 *   Ok(buf.into())  // Coll[Byte] of length 8
 *
 * Inverse of ByteArrayToLong (T4): i64 → 8-byte BE Coll[Byte].
 *
 * Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(17).
 *
 * Non-SLong input is rejected by `LongToByteArray::try_build` in sigma-rust at
 * build time (`ergotree-ir/src/mir/long_to_byte_array.rs:43-48` via
 * `OneArgOpTryBuild::try_build` → `check_post_eval_tpe`), so the fixture
 * cannot serialize a malformed tree. The `'predef-input-not-long'` assertion
 * is therefore covered by inline tests below that call `evalExpr` directly
 * with a hand-built MIR node (byte_array_to_long precedent).
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
import type { LongToByteArray as LongToByteArrayExpr } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/long-to-byte-array.json')

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

describe('LongToByteArray arm — fixture-driven', () => {
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

describe('LongToByteArray arm — non-SLong input', () => {
  it('throws predef-input-not-long when input is SInt', () => {
    const expr: LongToByteArrayExpr = {
      tag: 'LongToByteArray',
      input: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 42 },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-long')
  })
})
