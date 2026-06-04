/**
 * Layer C1 — SGlobal.groupGenerator handler (typeId 106, methodId 1).
 *
 * Pattern A cost 10 (charged before obj check). Returns the 33-byte SEC1
 * compressed secp256k1 generator point. Reuses GROUP_GENERATOR_BYTES from
 * eval/_group-generator.ts (no @noble/curves round-trip needed).
 *
 * Source: ergotree-interpreter/src/eval/sglobal.rs:32-41
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
import { GROUP_GENERATOR_BYTES } from '../../src/eval/_group-generator'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { PropertyCall as PropertyCallExpr } from '../../src/mir/types'

describe('SGlobal.groupGenerator handler (Layer C1)', () => {
  it('returns the generator point and charges cost 4 (dispatcher) + 5 (Global arm) + 10 (handler) = 19', () => {
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 1,
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES })
    expect(ctx.jitCost).toBe(19)
  })

  it('rejects when obj is not Global', () => {
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'Context' },
      typeId: 106,
      methodId: 1,
    }
    expect(() => evalPropertyCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface GroupGenEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface GroupGenFixture {
  corpus: string
  entries: GroupGenEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sglobal-group-generator.json')
const fixture: GroupGenFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SGlobal.groupGenerator — fixture-driven', () => {
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
