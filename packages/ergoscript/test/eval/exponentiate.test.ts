/**
 * Exponentiate arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/exponentiate.rs:13-33
 *   ctx.add_jit_cost(900)?;                              // Pattern A: BEFORE eval-children
 *   let left_v = self.left.eval(env, ctx)?.try_extract_into()?;
 *   let right_v = self.right.eval(env, ctx)?.try_extract_into()?;
 *   exponentiate(left_v, right_v)
 *
 * Then ec_point::exponentiate at ec_point.rs:111-119 — identity-base
 * short-circuit: `if !is_identity(base) { EcPoint(base.0 * exponent) }
 * else { *base }`.
 *
 * Cost-charging order: Pattern A — envelope BEFORE eval-children. Fixed(900).
 *
 * Throw paths (non-GroupElement base or non-BigInt exponent) are reached only
 * via synthesized MIR trees that bypass `Exponentiate::new`'s build-time
 * `(SGroupElement, SBigInt)` check. The fixture-gen module builds the
 * `Exponentiate` struct directly for throw entries (multiply_group.rs::
 * error_entry precedent).
 *
 * Critical guard validation: `exp_identity_k` exercises the explicit identity-
 * base guard in the TS handler (@noble/curves Point.multiply does NOT
 * short-circuit Point.ZERO; sigma-rust's ec_point::exponentiate does). The
 * expected value is 33 zero bytes.
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
const fixturePath = path.join(__dirname, '../fixtures/eval/exponentiate.json')

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

describe('Exponentiate arm — fixture-driven', () => {
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
