/**
 * CalcBlake2b256 arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/calc_blake2b256.rs:14-34
 *   let input_v = self.input.eval(env, ctx)?;          // eval-child FIRST
 *   match input_v { Coll[Byte](coll_byte) => {
 *       ctx.add_per_item_jit_cost(20, 7, 128, n)?;     // Pattern B: AFTER eval-child
 *       Ok(blake2b256_hash(coll_byte).to_vec().into())
 *   }, _ => Err(UnexpectedValue(...)) }
 *
 * Cost-charging order: Pattern B — child eval BEFORE envelope. Composite
 * per-item cost: 20 + ceil(n/128) * 7 (n = input bytes length).
 *
 * Non-Coll[Byte] input is rejected by `CalcBlake2b256::try_build` in
 * sigma-rust at build time (`ergotree-ir/src/mir/calc_blake2b256.rs:40-47`
 * via `OneArgOpTryBuild::try_build` → `check_post_eval_tpe`), so the fixture
 * cannot serialize a malformed tree. The `'predef-input-not-byte-array'`
 * assertion is therefore covered by inline tests below that call `evalExpr`
 * directly with a hand-built MIR node (bit_inversion precedent).
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
import type { CalcBlake2b256 as CalcBlake2b256Expr } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/calc-blake2b256.json')

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

describe('CalcBlake2b256 arm — fixture-driven', () => {
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

describe('CalcBlake2b256 arm — non-Coll[Byte] input', () => {
  it('throws predef-input-not-byte-array when input is SInt', () => {
    const expr: CalcBlake2b256Expr = {
      tag: 'CalcBlake2b256',
      input: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 42 },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-byte-array')
  })

  it('throws predef-input-not-byte-array when input is SBoolean', () => {
    const expr: CalcBlake2b256Expr = {
      tag: 'CalcBlake2b256',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-byte-array')
  })
})
