/**
 * SigmaPropIsProven arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25
 *   impl Evaluable for SigmaPropIsProven {
 *     fn eval(&self, _env, _ctx) -> Result<Value, EvalError> {
 *       Err(EvalError::Misc("SigmaPropIsProven has no interpreter eval ..."))
 *     }
 *   }
 *
 * Op-code 95 is reserved in the IR for byte-match parity with Scala
 * sigmastate, whose typer rewrites `prop.isProven` to a SigmaPropIsProven
 * node. The AOT graph-IR rewrite removes the node before evaluation; the
 * bytecode interpreter therefore receives a node that always throws.
 *
 * The arm has NO eval of `e.input` and NO cost charged — both `_env` and
 * `_ctx` are underscored in sigma-rust. The fixture-gen module follows the
 * throw-only convention (see decode_point.rs::error_entry) and does NOT call
 * `try_eval_out` — the input never matters, and this test asserts only the
 * expected error code.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/sigma-prop-is-proven.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: null
  expected_cost: number
  expected_error_code: string
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('SigmaPropIsProven arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      const err = captureEvalError(() => evaluateWith(tree, ctx))
      expect(err.code).toBe(entry.expected_error_code)
      expect(err.message).toContain('SigmaPropIsProven has no interpreter eval')
    })
  }
})
