/**
 * BinOp.Bit family — fixture-driven evaluation tests.
 *
 * Three bitwise ops (BitAnd, BitOr, BitXor) are fully implemented in
 * sigma-rust's BinOp evaluator; the three shift ops (BitShiftLeft,
 * BitShiftRight, BitShiftRightZeroed) are NOT — sigma-rust returns
 * EvalError::Misc("no interpreter eval") for those. Fixtures capture
 * both success cases (value + cost) and error cases (error code).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs:215-217
 *   BinOpKind::Bit(_) => { ctx.add_jit_cost(1)?; }
 *   // cost = Fixed(1) for envelope + 5 per Const operand → 11 total.
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
const fixturePath = path.join(__dirname, '../fixtures/eval/bin-op-bit.json')

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

describe('BinOp.Bit family — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
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
