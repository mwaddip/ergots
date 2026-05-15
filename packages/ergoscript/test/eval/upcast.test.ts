/**
 * Upcast arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/upcast.rs:78-80
 *   let input_v = self.input.eval(env, ctx)?;             // eval child FIRST
 *   ctx.add_jit_cost(if self.tpe == SType::SBigInt { 30 } else { 10 })?;
 *
 * Widening unary numeric conversion. Target kind read from `e.tpe`.
 * Result kind equals target. No overflow path — widening preserves the
 * source value exactly.
 *
 * Cost-charging order: envelope AFTER eval-child (sigma-rust line 78 →
 * 80). Differs from LogicalNot / BitInversion / Negation which charge
 * before. Costs: 30 for SBigInt target, 10 for any other numeric target
 * (inline literal in sigma-rust, not in `costs.rs`).
 *
 * Coverage:
 *   - 10 widening pairs (Byte → {Short,Int,Long,BigInt}, Short →
 *     {Int,Long,BigInt}, Int → {Long,BigInt}, Long → BigInt) × 2
 *     boundary values (0, MAX of source kind) = 20 happy entries.
 *   - 1 same-kind no-op (Int → Int). Same-kind for Byte/Short/Int/Long
 *     is permitted unconditionally; BigInt → BigInt requires tree_version
 *     ≥ V3, so our V0 fixtures cannot generate it (eval-time rejection).
 *
 * Non-numeric input is rejected by `Upcast::new` in sigma-rust at build
 * time (`ergotree-ir/src/mir/upcast.rs:29-48`), so the fixture cannot
 * serialize a malformed tree. The `'bin-op-not-numeric'` assertion is
 * therefore covered by an inline test that calls `evalExpr` directly
 * with a hand-built MIR node (BitInversion / Negation precedent).
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
import type { Upcast } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/upcast.json')

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

describe('Upcast arm — fixture-driven', () => {
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

describe('Upcast arm — non-numeric operand', () => {
  it('throws bin-op-not-numeric when operand is non-numeric', () => {
    const expr: Upcast = {
      tag: 'Upcast',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
      tpe: { tag: 'SInt' },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('bin-op-not-numeric')
  })
})
