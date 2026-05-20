/**
 * Xor arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/xor.rs:13-41
 *   let left_v = self.left.eval(env, ctx)?;
 *   let right_v = self.right.eval(env, ctx)?;
 *   match (left_v, right_v) { (Coll[Byte](l), Coll[Byte](r)) => {
 *       ctx.add_per_item_jit_cost(10, 2, 128, l.len() as u32)?;   // Pattern B; sized by LEFT
 *       Ok(helper_xor(l, r).into())                               // zip — truncates to shorter
 *   }, _ => Err(UnexpectedValue(...)) }
 *
 * Cost-charging order: Pattern B — both children eval BEFORE envelope.
 * Composite per-item cost: 10 + ceil(n/128) * 2 where n = LEFT operand's length
 * (NOT min(left, right)).
 *
 * Truncating-zip semantics: output length = min(left.length, right.length).
 * NO length-mismatch error in sigma-rust.
 *
 * Non-Coll[Byte] input is rejected by `Xor::new` in sigma-rust at MIR-build
 * time (`ergotree-ir/src/mir/xor.rs:27`), so the fixture cannot serialize a
 * malformed tree. The `'predef-input-not-byte-array'` assertion is therefore
 * covered by inline tests below that call `evalExpr` directly with hand-built
 * MIR nodes (calc_sha256 / bit_inversion precedent).
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
import type { Xor as XorExpr } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/xor.json')

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

describe('Xor arm — fixture-driven', () => {
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

describe('Xor arm — non-Coll[Byte] input', () => {
  it('throws predef-input-not-byte-array when LEFT is SInt', () => {
    const expr: XorExpr = {
      tag: 'Xor',
      left: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 42 },
      },
      right: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: { kind: 'Coll', elem: { tag: 'SByte' }, items: [] },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('predef-input-not-byte-array')
  })

  it('throws predef-input-not-byte-array when RIGHT is SBoolean', () => {
    const expr: XorExpr = {
      tag: 'Xor',
      left: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
        value: { kind: 'Coll', elem: { tag: 'SByte' }, items: [] },
      },
      right: {
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
