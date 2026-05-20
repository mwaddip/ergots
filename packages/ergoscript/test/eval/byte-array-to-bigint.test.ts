/**
 * ByteArrayToBigInt arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/byte_array_to_bigint.rs:14-34
 *   ctx.add_jit_cost(30)?;                              // Pattern A: BEFORE eval-child
 *   let input = self.input.eval(env, ctx)?.try_extract_into::<Vec<u8>>()?;
 *   if input.is_empty() { return Err(UnexpectedValue("byte array is empty")); }
 *   match BigInt256::from_be_slice(&input[..]) {
 *       Some(n) => Ok(Value::BigInt(n)),
 *       None    => Err(UnexpectedValue("input array out of bounds")),
 *   }
 *
 * `BigInt256::from_be_slice` (bigint256.rs:55-62) rejects empty and delegates to
 * `bnum::I256::from_be_slice` which returns `None` for slices whose value falls
 * outside `[I256::MIN, I256::MAX]`. The slice length is NOT capped at 32: 33+
 * byte inputs with leading sign-extension bytes succeed when their value fits.
 *
 * Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(30).
 *
 * Non-Coll[Byte] input is rejected by `ByteArrayToBigInt::try_build` in
 * sigma-rust at build time (`ergotree-ir/src/mir/byte_array_to_bigint.rs:43-49`
 * via `OneArgOpTryBuild::try_build` → `check_post_eval_tpe`), so the fixture
 * cannot serialize a malformed tree. The `'predef-input-not-byte-array'`
 * assertion is therefore covered by an inline test below that calls `evalExpr`
 * directly with a hand-built MIR node (byte_array_to_long precedent).
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
import type { ByteArrayToBigInt as ByteArrayToBigIntExpr } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/byte-array-to-bigint.json')

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

describe('ByteArrayToBigInt arm — fixture-driven', () => {
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

describe('ByteArrayToBigInt arm — non-Coll[Byte] input', () => {
  it('throws predef-input-not-byte-array when input is SLong', () => {
    const expr: ByteArrayToBigIntExpr = {
      tag: 'ByteArrayToBigInt',
      input: {
        tag: 'Const',
        tpe: { tag: 'SLong' },
        value: { kind: 'Long', value: 42n },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-byte-array')
  })
})
