/**
 * ValDef arm — top-level rejection.
 *
 * `Expr::ValDef` is only valid as an item inside `BlockValue.items`.
 * Reaching it at the top level is a structural error — the
 * `BlockValue` arm (task 15) is the only path that bypasses the
 * central dispatch and consumes ValDefs in-line.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval.rs:66-68
 *   Expr::ValDef(_) => Err(EvalError::UnexpectedExpr(...))
 *
 * We assert: the evaluator throws an EvalError with code
 * 'val-def-outside-block' when handed a tree whose body is a ValDef.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluate } from '../../src/eval/evaluate'
import { EvalError } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { hexToBytes } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/val-def.json')

interface ValDefErrorFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number; constants?: unknown[] }
  expected_error_code: string
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: ValDefErrorFixture[]
}

describe('ValDef arm — top-level rejection', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: throws ${entry.expected_error_code}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      // Fixture only ever emits `{}` for ValDef rejection — no constants /
      // jitCostLimit needed. Cast through unknown so the JSON-shape
      // `unknown[]` doesn't fight `EvalOpts.constants: SValue[]`.
      const opts = entry.opts_json as unknown as EvalOpts
      expect(() => evaluate(tree, opts)).toThrow(EvalError)
      try {
        evaluate(tree, opts)
      } catch (e) {
        expect((e as EvalError).code).toBe(entry.expected_error_code)
      }
    })
  }
})
