/**
 * Layer C1 — SContext.preHeader handler (typeId 101, methodId 3).
 *
 * Pattern A cost 15 (charged before obj check). Returns
 * { kind: 'PreHeader', value: ctx.preHeader }.
 *
 * Total eval cost: 4 (dispatcher) + 1 (Context arm) + 15 (handler) = 20.
 *
 * Source: ergotree-interpreter/src/eval/scontext.rs:72-81
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
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticPreHeader(): PreHeader {
  return {
    version: 3,
    parentId: new Uint8Array(32),
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height: 1000000,
    minerPk: new Uint8Array(33),
    votes: new Uint8Array(3),
  }
}

describe('SContext.preHeader handler (Layer C1)', () => {
  it('returns wrapped PreHeader and charges 4 + 1 + 15 = 20', () => {
    const preHeader = syntheticPreHeader()
    const ctx = makeContext({ preHeader })
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'PreHeader', value: preHeader })
    expect(ctx.jitCost).toBe(20)
  })

  it('throws context-field-missing when ctx.preHeader is undefined', () => {
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
  })

  it('throws context-obj-not-context when obj is not Context', () => {
    const ctx = makeContext({ preHeader: syntheticPreHeader() })
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Global' },
      typeId: 101,
      methodId: 3,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-obj-not-context')
  })
})

interface PreHeaderEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface PreHeaderFixture {
  corpus: string
  entries: PreHeaderEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/scontext-pre-header.json')
const fixture: PreHeaderFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SContext.preHeader — fixture-driven', () => {
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
