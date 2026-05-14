/**
 * Const arm — fixture-driven evaluation tests.
 *
 * Each fixture entry is a serialized ErgoTree whose body is a single
 * `Expr::Const(...)` literal. We assert the evaluator returns the literal's
 * value and charges a flat 5 JIT cost (matches sigma-rust
 * `ergotree-interpreter/src/eval/expr.rs:21-24`).
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
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/const.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  // The Const arm fixture only sets jitCostLimit; later arms grow this
  // shape additively. Typed as EvalOpts so the spread into makeContext
  // is type-safe without losing forward extensibility.
  opts_json: EvalOpts
  expected_value_json: { kind: string; value?: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('Const arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
