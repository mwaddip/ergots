/**
 * MultiplyGroup arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/multiply_group.rs:9-29
 *   ctx.add_jit_cost(40)?;                              // Pattern A: BEFORE eval-children
 *   let left_v = self.left.eval(env, ctx)?;
 *   let right_v = self.right.eval(env, ctx)?;
 *   match (&left_v, &right_v) {
 *     (Value::GroupElement(l), Value::GroupElement(r)) => Ok(((**l) * r).into()),
 *     _ => Err(EvalError::UnexpectedValue(...)),
 *   }
 *
 * Group "multiply" = point ADDITION on the curve via Mul<&EcPoint> at
 * ec_point.rs:74-80 (`ProjectivePoint::add`). Multiplicative-notation group.
 *
 * Cost-charging order: Pattern A — envelope BEFORE eval-children. Fixed(40).
 *
 * Throw paths (non-GroupElement left or right) are reached only via
 * synthesized MIR trees that bypass `MultiplyGroup::new`'s build-time
 * `(SGroupElement, SGroupElement)` check. The fixture-gen module builds the
 * `MultiplyGroup` struct directly for throw entries (decode_point.rs::error_entry
 * precedent).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/multiply-group.json')

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

describe('MultiplyGroup arm — fixture-driven', () => {
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
