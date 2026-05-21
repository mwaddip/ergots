/**
 * DeserializeRegister arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/deserialize_register.rs (tests-only)
 *                 ergotree-ir/src/mir/expr.rs:442-496, 478-481 (substitute_deserialize
 *                   + register-absent-no-default LEAVE-node semantics)
 *                 ergotree-interpreter/src/eval.rs:203-250 (substitute-pre-pass dispatch)
 *
 * Architecture: substitute-pre-pass. `substituteDeserialize` rewrites the
 * DeserializeRegister arm before eval. The arm reads `ctx.selfBox.registers[reg]`
 * as Coll[Byte], parses inner Expr, type-checks, and splices in place. When
 * the register is absent AND `default` is null, the substitute pass LEAVES
 * the node unchanged (mirrors sigma-rust expr.rs:478-481); the defensive
 * eval-time throw `'deserialize-not-substituted'` (T3) catches.
 *
 * Tests should PASS immediately because T2-T8 architecture handles both
 * DeserializeContext + DeserializeRegister identically. No RED step.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/deserialize-register.json')

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

describe('DeserializeRegister arm — fixture-driven', () => {
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
