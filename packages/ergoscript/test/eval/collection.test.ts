/**
 * Collection arm — fixture-driven evaluation tests.
 *
 * Covers both wire variants:
 *   - `kind: 'BoolConstants'` (opcode COLL_OF_BOOL_CONST) — bools inlined in
 *     the variant; envelope cost 20, no per-item recursion.
 *   - `kind: 'Exprs'` (opcode COLL) — items are sub-expressions; envelope
 *     cost 20 + recursive item costs (e.g. 3 Const items add 3 * 5 = 15,
 *     yielding 35 for a 3-Int coll).
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/collection.rs:22`.
 *
 * Long / BigInt SValue items in fixture JSON come across as decimal strings
 * (no native bigint literal in JSON) and are rehydrated to `bigint` here
 * recursively so the deep-equal comparison succeeds against the `SValue`
 * union.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/collection.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: any
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('Collection arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
