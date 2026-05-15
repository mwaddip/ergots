/**
 * Negation arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/negation.rs:16
 *   ctx.add_jit_cost(30)?;                       // Negation = Fixed(30)
 *   let input_v = self.input.eval(env, ctx)?;    // eval child after cost
 *   match input_v { Byte/Short/Int/Long/BigInt => checked_neg, ... }
 *
 * Unary numeric negate (`-x`). Result kind equals input kind. Overflow
 * (`Negate(MIN_K)`) raises `'arith-overflow'` (reused from 2c
 * BinOp.Arith — same semantic).
 *
 * Cost-charging order: envelope BEFORE eval-child (sigma-rust line 16 →
 * 17). Matches LogicalNot / BitInversion posture.
 *
 * Coverage:
 *   - 5 kinds × 2 boundary values (0, MAX_K) = 10 happy entries.
 *   - 5 overflow entries (`Negate(MIN_K)` per kind).
 *   - 1 cost-limit entry (`jitCostLimit` < 30) → `'cost-limit-exceeded'`.
 *
 * Non-numeric input is rejected by `Negation::try_build` in sigma-rust
 * at build time (`ergotree-ir/src/mir/negation.rs:38-50`), so the
 * fixture cannot serialize a malformed tree. The `'bin-op-not-numeric'`
 * assertion is therefore covered by an inline test that calls
 * `evalExpr` directly with a hand-built MIR node (BitInversion
 * precedent).
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
import type { Negation } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/negation.json')

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

describe('Negation arm — fixture-driven', () => {
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

describe('Negation arm — non-numeric operand', () => {
  it('throws bin-op-not-numeric when operand is non-numeric', () => {
    const expr: Negation = {
      tag: 'Negation',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('bin-op-not-numeric')
  })
})
