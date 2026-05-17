/**
 * Layer C1 — `Context` Expr arm.
 *
 * Trivial arm: cost 1 (Pattern A); returns `{ kind: 'Context' }` SValue sentinel.
 * Source: ergotree-interpreter/src/eval/expr.rs:38.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalContext } from '../../src/eval/context'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { Context as ContextExpr } from '../../src/mir/types'

// ---------------------------------------------------------------------------
// Unit test — inline MIR node, no fixture on disk.
// ---------------------------------------------------------------------------

describe('evalContext (Layer C1)', () => {
  it('returns { kind: "Context" } and charges cost 1', () => {
    const ctx = makeContext({})
    const e: ContextExpr = { tag: 'Context' }
    const result = evalContext(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Context' })
    expect(ctx.jitCost).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Fixture-driven — sigma-rust is the oracle for value + cost.
// ---------------------------------------------------------------------------

interface ContextEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface ContextFixture {
  corpus: string
  entries: ContextEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/context.json')
const fixture: ContextFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('Context arm — fixture-driven', () => {
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
