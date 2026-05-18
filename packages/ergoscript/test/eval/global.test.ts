/**
 * Layer C1 — `Global` Expr arm.
 *
 * Trivial arm: cost 5 (Pattern A); returns `{ kind: 'Global' }` SValue
 * sentinel. Mirrors the 2g.5 Context arm pattern (different cost, different
 * sentinel kind). Source: ergotree-interpreter/src/eval/expr.rs:37-40.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalGlobal } from '../../src/eval/global'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { Global as GlobalExpr } from '../../src/mir/types'

// ---------------------------------------------------------------------------
// Unit test — inline MIR node, no fixture on disk.
// ---------------------------------------------------------------------------

describe('evalGlobal (Layer C1)', () => {
  it('returns { kind: "Global" } and charges cost 5', () => {
    const ctx = makeContext({})
    const e: GlobalExpr = { tag: 'Global' }
    const result = evalGlobal(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Global' })
    expect(ctx.jitCost).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Fixture-driven — sigma-rust is the oracle for value + cost.
// ---------------------------------------------------------------------------

interface GlobalEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface GlobalFixture {
  corpus: string
  entries: GlobalEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/global.json')
const fixture: GlobalFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('Global arm — fixture-driven', () => {
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
