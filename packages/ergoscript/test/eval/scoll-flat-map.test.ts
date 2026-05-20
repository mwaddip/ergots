/**
 * Layer C1 — SColl.flatMap handler (typeId 12, methodId 15). Phase 2h-f.
 *
 * Pattern B cost `addPerItemCost(60, 10, 8, n)` charged AFTER all guards.
 * Lambda HOF with concat semantics + body-restriction quirk
 * (MethodCall body must have 0 args, per sigma-rust scoll.rs:78-84) +
 * SAny-tolerant outElem with first-iter refinement.
 *
 * Source: ergotree-interpreter/src/eval/scoll.rs:52-136 — flatmap_eval
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/scoll-flat-map.json')
const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SColl.flatMap — fixture-driven (Layer C1)', () => {
  for (const entry of fixture.entries) {
    if (entry.expected_error_code !== null) {
      it(`${entry.name} throws ${entry.expected_error_code}`, () => {
        const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
        const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
        try {
          evaluateWith(tree, ctx)
          throw new Error('expected throw')
        } catch (e) {
          expect(e).toBeInstanceOf(EvalError)
          expect((e as EvalError).code).toBe(entry.expected_error_code)
        }
      })
    } else {
      it(entry.name, () => {
        const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
        const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      })
    }
  }
})
