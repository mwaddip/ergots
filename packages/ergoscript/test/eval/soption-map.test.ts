/**
 * SOption.map handler (typeId 36, methodId 7) — campaign iter-29.
 *
 * `Option[T].map(f: T => R): Option[R]` — lambda HOF.
 *
 * Fixed cost 20 (Pattern A, charged first). `Some(t)` → `Some(lambda(t))`;
 * `None` → `None`. Lambda invocation mirrors SColl.flatMap's env-extend.
 * Result Option elem type = exprTpe(lambda body). V0 (no version gate).
 *
 * Source: ergotree-interpreter/src/eval/soption.rs:13-60 (map_eval).
 *
 * Fixtures build the receiver as `ExtractRegisterAs(box, R4, Option[T]).map(f)`
 * (an Option Constant can't be sigma-serialized; Options arise from operations).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeContext } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

interface MapEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface MapFixture {
  corpus: string
  entries: MapEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/soption-map.json')
const fixture: MapFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SOption.map — fixture-driven', () => {
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
