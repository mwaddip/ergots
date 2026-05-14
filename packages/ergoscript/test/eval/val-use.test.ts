/**
 * ValUse arm — env lookup + per-arm cost.
 *
 * ValUse cannot be exercised at top level; it requires a binding in Env.
 * sigma-rust's `Evaluable::eval` is `pub(crate)`, so the fixture-gen side
 * wraps the ValUse in a BlockValue (so `try_eval_out` can run end-to-end
 * and capture the *total* cost of the wrapping block). Here on the TS
 * side we hand-construct an Env with the binding and dispatch `evalExpr`
 * directly on a bare ValUse, isolating the per-arm cost (5).
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/val_use.rs:15-19`
 *   _ctx.add_jit_cost(5)?;
 *   env.get(self.val_id).cloned().ok_or_else(|| EvalError::NotFound(...))
 *
 * Cost is charged BEFORE the env lookup; an unbound ValUse therefore
 * still increments `ctx.jitCost` by 5 before throwing.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SType, ValUse } from '../../src/mir/types'
import { hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/val-use.json')

interface ValUseFixture {
  name: string
  tree_bytes_hex: string
  val_id: number
  tpe_json: SType
  env_bindings: Array<[number, { kind: string; value?: unknown }]>
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: ValUseFixture[]
}

function buildEnv(bindings: Array<[number, { kind: string; value?: unknown }]>): Env {
  let env = Env.empty()
  for (const [id, v] of bindings) env = env.extend(id, hydrateSValue(v))
  return env
}

describe('ValUse arm', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}`, () => {
      const expr: ValUse = { tag: 'ValUse', valId: entry.val_id, tpe: entry.tpe_json }
      const env = buildEnv(entry.env_bindings)
      const ctx = makeContext()

      if (entry.expected_error_code) {
        expect(() => evalExpr(expr, env, ctx)).toThrow(EvalError)
        // Cost was charged BEFORE the env lookup threw — re-running re-charges,
        // so use a fresh context for the cost assertion.
        const ctx2 = makeContext()
        try {
          evalExpr(expr, env, ctx2)
        } catch (e) {
          expect((e as EvalError).code).toBe(entry.expected_error_code)
        }
        expect(ctx2.jitCost).toBe(entry.expected_cost)
      } else {
        const value = evalExpr(expr, env, ctx)
        // NB: ValUse-only cost (5), NOT the wrapping-block total in
        // entry.expected_cost (which captures the BlockValue+ValDef+Const+ValUse
        // path that the fixture-gen side ran end-to-end).
        expect(value).toEqual(hydrateSValue(entry.expected_value_json!))
        expect(ctx.jitCost).toBe(5)
      }
    })
  }
})
