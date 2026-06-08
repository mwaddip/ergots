/**
 * SContext method handlers — SContext.lastBlockUtxoRootHash (typeId 101, methodId 9).
 *
 * Phase 2h-c.1 Step 4; F5 batch 2 (2026-06-08) relocation.
 *
 * Pattern A cost 15 (charged before obj check). Returns the AvlTree carried by
 * the INDEPENDENT `ctx.lastBlockUtxoRootHash` field (JVM
 * `ErgoLikeContext.lastBlockUtxoRoot`). F5 batch 2: NO LONGER derived from
 * `ctx.headers[0].stateRoot` (that was the sigma-rust quirk at scontext.rs:83-99).
 *
 * Total eval cost: 4 (dispatcher) + 1 (Context arm) + 15 (handler) = 20.
 *
 * Source: JVM ErgoLikeContext.lastBlockUtxoRoot (canonical).
 *
 * Tests:
 *   1. Oracle fixture-driven: 1 entry — the supplied field round-trips out.
 *   2. Field PRESENT → returns {kind:'AvlTree', value:<the field>}, full cost 20.
 *   3. Field ABSENT → throws 'context-field-missing' (handler cost 15 charged
 *      first — Pattern A; observable total 20 via evalPropertyCall).
 *   4. headers present but field absent → still throws 'context-field-missing'
 *      (confirms headers no longer drives 101:9).
 *   5. obj.kind !== 'Context' → throws 'context-obj-not-context'.
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
import type { PropertyCall as PropertyCallExpr, AvlTreeData } from '../../src/mir/types'

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

// PropertyCall(Context, lastBlockUtxoRootHash) — reused across handler tests.
const propertyCallExpr: PropertyCallExpr = {
  tag: 'PropertyCall',
  explicitTypeArgs: {},
  obj: { tag: 'Context' },
  typeId: 101,
  methodId: 9,
}

// A representative AvlTreeData field value (distinct, non-zero digest so we'd
// catch any accidental headers-derivation: it does NOT match the fixture's
// 33-zero stateRoot).
const sampleField: AvlTreeData = {
  digest: hexToBytes('01' + '00'.repeat(32)),
  treeFlags: 0b00000111,
  keyLength: 32,
  valueLengthOpt: null,
}

// ---------- Oracle fixture-driven test ----------

describe('SContext.lastBlockUtxoRootHash — oracle fixture-driven (F5 batch 2)', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      // F5 batch 2: 101:9 reads the independent ctx.lastBlockUtxoRootHash
      // field, NOT headers. Feed the field as the fixture's expected
      // AvlTreeData (hydrate the AvlTree SValue, take its .value); the handler
      // must return exactly that AvlTree at the fixture's cost.
      const expected = hydrateSValue(entry.expected_value_json)
      if (expected.kind !== 'AvlTree') {
        throw new Error(`fixture ${entry.name} expected an AvlTree value`)
      }
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({
        ...rehydrateEvalOpts(entry.opts_json),
        lastBlockUtxoRootHash: expected.value,
      })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(expected)
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

// ---------- Field PRESENT → returns it ----------

describe('SContext.lastBlockUtxoRootHash — field present', () => {
  it('returns {kind:AvlTree, value:<the field>} and charges full cost 20', () => {
    const ctx = makeContext({ lastBlockUtxoRootHash: sampleField })
    const value = evalPropertyCall(propertyCallExpr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'AvlTree', value: sampleField })
    // evalPropertyCall: 4 (PropertyCall dispatcher) + 1 (Context obj arm) +
    // 15 (handler, Pattern A) = 20.
    expect(ctx.jitCost).toBe(20)
  })
})

// ---------- Field ABSENT → context-field-missing (cost charged first) ----------

describe('SContext.lastBlockUtxoRootHash — field absent', () => {
  it('throws context-field-missing when ctx.lastBlockUtxoRootHash is undefined', () => {
    const ctx = makeContext({})
    const err = captureEvalError(() =>
      evalPropertyCall(propertyCallExpr, Env.empty(), ctx)
    )
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
    // Pattern A: the handler's cost 15 is charged BEFORE the throw; via
    // evalPropertyCall the observable total is 4 (dispatcher) + 1 (Context arm)
    // + 15 (handler) = 20 — i.e. cost accrues fully, then the field check throws.
    expect(ctx.jitCost).toBe(20)
  })

  it('still throws context-field-missing when headers present but field absent', () => {
    // Confirms F5 batch 2: headers no longer drives 101:9. The fixture's
    // opts_json supplies a 10-element headers array; with the new field absent
    // the handler must NOT fall back to headers[0].stateRoot.
    const ctx = makeContext(rehydrateEvalOpts(fixture.entries[0]!.opts_json))
    expect(ctx.headers).toBeDefined()
    expect(ctx.headers!.length).toBeGreaterThan(0)
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
      explicitTypeArgs: {},
      obj: { tag: 'Global' },
      typeId: 101,
      methodId: 9,
    }
    // Field populated so we confirm the obj check fires before the field check.
    const ctx = makeContext({ lastBlockUtxoRootHash: sampleField })
    const err = captureEvalError(() =>
      evalPropertyCall(nonContextExpr, Env.empty(), ctx)
    )
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-obj-not-context')
  })
})

// ---------- SContext.headers — defensive obj-kind check ----------

describe('SContext.headers — defensive obj-kind check', () => {
  it('throws context-obj-not-context when obj is not Context', () => {
    // Construct PropertyCall(Global, headers) — obj will be 'Global'.
    const nonContextExpr: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Global' },
      typeId: 101,
      methodId: 2,
    }
    // ctx.headers must be populated to confirm the obj check fires (not a
    // missing-headers path). Use the fixture's opts_json which includes a headers array.
    const ctx = makeContext(rehydrateEvalOpts(fixture.entries[0]!.opts_json))
    const err = captureEvalError(() =>
      evalPropertyCall(nonContextExpr, Env.empty(), ctx)
    )
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-obj-not-context')
  })
})
