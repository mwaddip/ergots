/**
 * SAvlTree.updateOperations (100:8) — Tier-2 mutator op handler.
 *
 * RED phase (Task 2 of phase 2h-d): the dispatcher has no handler for
 * typeId=100, methodId=8 yet. This test loads the fixture and asserts
 * evaluate() value + cost; until Task 3 wires the handler, the dispatcher
 * throws EvalError('method-not-implemented') before the assertions run.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

interface UpdateOperationsEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface UpdateOperationsFixture {
  corpus: string
  entries: UpdateOperationsEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-update-operations.json')
const fixture: UpdateOperationsFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.updateOperations (100:8) — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
