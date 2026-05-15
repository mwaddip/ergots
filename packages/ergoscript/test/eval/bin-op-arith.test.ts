/**
 * BinOp.Arith family — fixture-driven evaluation tests.
 *
 * Covers all seven arithmetic ops:
 *   Plus, Minus, Multiply, Divide, Max, Min, Modulo
 *
 * Operand kinds: Byte/Short/Int/Long/BigInt (all must share same kind).
 *
 * Cost model (sigma-rust bin_op.rs:194-203):
 *   is_bigint derived from left operand: matches!(lv, Value::BigInt(_) | Value::UnsignedBigInt(_))
 *   Plus/Minus:              15 (non-bigint) / 20 (bigint)
 *   Multiply/Divide/Modulo:  15 (non-bigint) / 25 (bigint)
 *   Max/Min:                  5 (non-bigint) / 10 (bigint)
 *   Charged AFTER left-eval, BEFORE right-eval (cost ordering from bin_op.rs:190-218).
 *
 * For two Const operands (each costing 5), total cost examples:
 *   Plus(Int, Int):        15 + 5 + 5 = 25
 *   Plus(BigInt, BigInt):  20 + 5 + 5 = 30
 *   Multiply(Int, Int):    15 + 5 + 5 = 25
 *   Multiply(BigInt, ...): 25 + 5 + 5 = 35
 *   Max(Int, Int):          5 + 5 + 5 = 15
 *   Max(BigInt, ...):      10 + 5 + 5 = 20
 *
 * Error cases:
 *   - 'arith-overflow': result outside signed range for Plus/Minus/Multiply/Divide/Modulo.
 *   - 'arith-divide-by-zero': right operand is 0 for Divide/Modulo.
 *   - 'bin-op-not-numeric': non-numeric operand kind.
 *   - 'bin-op-kind-mismatch': operands have different kinds.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs (Arith arm).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/bin-op-arith.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: any
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('BinOp.Arith family — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ jitCostLimit: entry.opts_json.jitCostLimit })
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
