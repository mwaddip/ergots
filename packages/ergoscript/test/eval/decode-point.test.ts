/**
 * DecodePoint arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/decode_point.rs:14-30
 *   ctx.add_jit_cost(300)?;                              // Pattern A: BEFORE eval-child
 *   let point_bytes = self.input.eval(env, ctx)?
 *       .try_extract_into::<Vec<u8>>()?;
 *   let point: EcPoint = SigmaSerializable::sigma_parse_bytes(&point_bytes)
 *       .map_err(|_| Misc(format!(...)))?;
 *   Ok(point.into())
 *
 * Cost-charging order: Pattern A — envelope BEFORE eval-child. Fixed(300).
 *
 * Non-Coll[Byte] input is rejected by `DecodePoint::try_build` in sigma-rust
 * at build time (`ergotree-ir/src/mir/decode_point.rs:43-48`), so the fixture
 * cannot serialize a malformed tree. The `'predef-input-not-byte-array'`
 * assertion is therefore covered by inline tests below that call `evalExpr`
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
import type { DecodePoint as DecodePointExpr } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/decode-point.json')

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

describe('DecodePoint arm — fixture-driven', () => {
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

describe('DecodePoint arm — non-Coll[Byte] input', () => {
  it('throws predef-input-not-byte-array when input is SInt', () => {
    const expr: DecodePointExpr = {
      tag: 'DecodePoint',
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
    const expr: DecodePointExpr = {
      tag: 'DecodePoint',
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
