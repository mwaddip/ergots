/**
 * SContext method handlers — SContext.lastBlockUtxoRootHash (typeId 101, methodId 9).
 *
 * Phase 2h-c.1 Step 4.
 *
 * Pattern A cost 15 (charged before obj check). Synthesizes AvlTreeData from
 * ctx.headers[0].stateRoot with treeFlags=0b00000111 (insert/update/remove),
 * keyLength=32, valueLengthOpt=null.
 *
 * Total eval cost: 4 (dispatcher) + 1 (Context arm) + 15 (handler) = 20.
 *
 * Source: ergotree-interpreter/src/eval/scontext.rs:83-99
 *
 * Tests:
 *   1. Oracle fixture-driven: 1 entry from eval/scontext-last-block-utxo-root-hash.json.
 *   2. Defensive: throws 'context-field-missing' when ctx.headers is undefined.
 *   3. Defensive: throws 'context-field-missing' when ctx.headers is [].
 *   4. Defensive: throws 'context-obj-not-context' when obj is not Context.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'
import type { PropertyCall as PropertyCallExpr } from '../../src/mir/types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(
  __dirname,
  '../fixtures/eval/scontext-last-block-utxo-root-hash.json'
)

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, 'utf-8'))

// ---------- Oracle fixture-driven tests ----------

describe('SContext.lastBlockUtxoRootHash — oracle fixture-driven (Phase 2h-c.1)', () => {
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

// ---------- Defensive: context-field-missing ----------

describe('SContext.lastBlockUtxoRootHash — defensive ctx.headers checks', () => {
  const propertyCallExpr: PropertyCallExpr = {
    tag: 'PropertyCall',
    obj: { tag: 'Context' },
    typeId: 101,
    methodId: 9,
  }

  it('throws context-field-missing when ctx.headers is undefined', () => {
    // makeContext({}) produces a context with ctx.headers === undefined.
    const ctx = makeContext({})
    const err = captureEvalError(() =>
      evalPropertyCall(propertyCallExpr, Env.empty(), ctx)
    )
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })

  it('throws context-field-missing when ctx.headers is empty array', () => {
    // Pass headers: [] — sigma-rust would panic on empty-array indexing;
    // our TS port surfaces it as 'context-field-missing'.
    const ctx = makeContext({ headers: [] })
    const err = captureEvalError(() =>
      evalPropertyCall(propertyCallExpr, Env.empty(), ctx)
    )
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })
})

// ---------- Defensive: context-obj-not-context ----------

describe('SContext.lastBlockUtxoRootHash — defensive obj-kind check', () => {
  it('throws context-obj-not-context when obj evaluates to non-Context', () => {
    // Construct PropertyCall(Global, lastBlockUtxoRootHash) — obj will be 'Global'.
    const nonContextExpr: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Global' },
      typeId: 101,
      methodId: 9,
    }
    // ctx.headers must be populated to confirm the obj check fires (not the
    // headers check). Use the fixture's opts_json which includes a headers array.
    const ctx = makeContext(rehydrateEvalOpts(fixture.entries[0]!.opts_json))
    const err = captureEvalError(() =>
      evalPropertyCall(nonContextExpr, Env.empty(), ctx)
    )
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-obj-not-context')
  })
})
