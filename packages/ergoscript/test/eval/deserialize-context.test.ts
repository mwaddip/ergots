/**
 * DeserializeContext arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/deserialize_context.rs (tests-only)
 *                 ergotree-ir/src/mir/expr.rs:442-496 (substitute_deserialize)
 *                 ergotree-interpreter/src/eval.rs:203-250 (substitute-pre-pass dispatch)
 *
 * Architecture: substitute-pre-pass. `substituteDeserialize` runs as a bottom-up
 * tree rewrite before `tryTrivialReduceExpr` + `evalExpr`. The Deserialize* eval
 * arms are defensive throws (T3).
 *
 * RED state (this test landing at T7, before T8 integration): every entry's
 * `evaluate` call hits the T3 defensive throw `'deserialize-not-substituted'`
 * because T8 (the substitute integration in evaluate.ts) has not landed yet.
 * Most tests fail with code mismatch; the P2PK 50-cost canary
 * (`dc_const_sigmaprop_inner`) fails on value too.
 *
 * GREEN state (after T8): every entry's evaluate hits the substitute pass,
 * which rewrites the DeserializeContext arm into its inner Expr, then runs
 * `tryTrivialReduceExpr` (50-cost short-circuit fires for the SigmaProp inner)
 * or `evalExpr` for normal evaluation.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, hydrateSValue, rehydrateEvalOpts, parseParsedTree as parseTree } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/deserialize-context.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error: string | null
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('DeserializeContext arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({
        ...rehydrateEvalOpts(entry.opts_json),
        // evaluateWith does NOT auto-default constants from tree; supply explicitly.
        constants: tree.constants,
        treeVersion: tree.header.version,
      })
      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
        if (entry.expected_error !== null) {
          expect(err.message).toContain(entry.expected_error)
        }
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
