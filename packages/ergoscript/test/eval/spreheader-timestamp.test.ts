/**
 * Layer C1 — SPreHeader.timestamp handler (typeId 105, methodId 3).
 *
 * Pattern A cost 10 (charged before obj check). Returns
 * { kind: 'Long', value: preHeader.timestamp }.
 *
 * Source: ergotree-interpreter/src/eval/spreheader.rs:20-24
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

function syntheticPreHeader(timestamp: bigint): PreHeader {
  return {
    version: 3,
    parentId: new Uint8Array(32),
    timestamp,
    nBits: 0x18000000,
    height: 1000000,
    minerPk: new Uint8Array(33),
    votes: new Uint8Array(3),
  }
}

describe('SPreHeader.timestamp handler (Layer C1)', () => {
  it('returns timestamp as Long; chain Context.preHeader.timestamp charges 34', () => {
    const preHeader = syntheticPreHeader(1700000000000n)
    const ctx = makeContext({ preHeader })
    // Outer PropertyCall: SPreHeader.timestamp on the inner result
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: innerPreHeader,
      typeId: 105,
      methodId: 3,
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Long', value: 1700000000000n })
    // 4 (outer disp) + 4 (inner disp) + 1 (Context arm) + 15 (preHeader handler) + 10 (timestamp handler) = 34
    expect(ctx.jitCost).toBe(34)
  })

  it('boundary: timestamp near i64::MAX passes through unchanged', () => {
    const max = 9223372036854775807n // i64::MAX
    const preHeader = syntheticPreHeader(max)
    const ctx = makeContext({ preHeader })
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: innerPreHeader,
      typeId: 105,
      methodId: 3,
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Long', value: max })
  })

  it('rejects when obj is not PreHeader (uses .code assertion)', () => {
    const ctx = makeContext({})
    // Direct PropertyCall(Context, timestamp) — Context obj (not PreHeader)
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 105,
      methodId: 3,
    }
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
  })
})

interface TimestampEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface TimestampFixture {
  corpus: string
  entries: TimestampEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/spreheader-timestamp.json')
const fixture: TimestampFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SPreHeader.timestamp — fixture-driven', () => {
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
