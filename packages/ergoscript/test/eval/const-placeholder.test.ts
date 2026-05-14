/**
 * ConstPlaceholder arm — fixture-driven evaluation tests.
 *
 * Each fixture entry is a serialized ErgoTree whose body is a single
 * `Expr::ConstPlaceholder(...)` referencing `tree.constants[id]`. We assert
 * the evaluator returns the resolved literal's value and charges a flat 1
 * JIT cost (matches sigma-rust `ergotree-interpreter/src/eval/expr.rs:52-64`,
 * `ConstantPlaceholder = Fixed(1)`).
 *
 * The fixture-gen oracle uses `tree.root_expr()` + `ctx.with_constants(...)`
 * (lazy-resolution path) rather than `tree.proposition()` so the
 * `ConstPlaceholder` arm actually fires (substituting placeholders pre-eval
 * would route through the `Const` arm at cost 5 instead).
 *
 * Long / BigInt are encoded as decimal strings in the fixture JSON (no
 * native bigint literal in JSON) and rehydrated to `bigint` here so the
 * `expect(...).toEqual(...)` comparison works against the SValue union.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/const-placeholder.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number; constants?: unknown[] }
  expected_value_json: { kind: string; value?: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('ConstPlaceholder arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ constants: tree.constants })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('ConstPlaceholder arm — error cases', () => {
  it('throws const-placeholder-no-constants when ctx.constants is undefined', () => {
    const tree = parseTree(hexToBytes(fixture.entries[0]!.tree_bytes_hex))
    const ctx = makeContext() // no constants
    expect(() => evaluateWith(tree, ctx)).toThrow(EvalError)
    try {
      evaluateWith(tree, ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('const-placeholder-no-constants')
    }
  })

  it('throws const-placeholder-id-out-of-range when id >= constants.length', () => {
    const tree = parseTree(hexToBytes(fixture.entries[0]!.tree_bytes_hex))
    const ctx = makeContext({ constants: [] }) // empty constants
    expect(() => evaluateWith(tree, ctx)).toThrow(EvalError)
    try {
      evaluateWith(tree, ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('const-placeholder-id-out-of-range')
    }
  })
})
