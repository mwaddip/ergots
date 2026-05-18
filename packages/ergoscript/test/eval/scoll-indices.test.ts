/**
 * Layer C1 — SColl.indices handler (typeId 12, methodId 14).
 *
 * Pattern B cost addPerItemCost(20, 2, 16, n) (charged after Coll
 * extraction). Returns Coll[Int] = 0..n-1.
 *
 * Source: ergotree-interpreter/src/eval/scoll.rs:171-193
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { MethodCall as MethodCallExpr, SType, SValue } from '../../src/mir/types'

// SType singletons used in test fixtures.
const SLONG: SType = { tag: 'SLong' }
const SINT: SType = { tag: 'SInt' }

function collOf(items: SValue[], elem: SType): SValue {
  return { kind: 'Coll', elem, items }
}

// Build a Const Expr node — matches the `Const` interface in mir/types.ts:
//   { tag: 'Const', tpe: SType, value: SValue }
function constExpr(value: SValue, tpe: SType): any {
  return { tag: 'Const', tpe, value }
}

describe('SColl.indices handler (Layer C1)', () => {
  it('empty Coll → empty Coll[Int]', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(collOf([], SLONG), { tag: 'SColl', elem: SLONG }),
      args: [],
      typeId: 12,
      methodId: 14,
      explicitTypeArgs: {},
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Coll', elem: SINT, items: [] })
    // Dispatcher 4 + Const arm 5 + handler base 20 + ceil(0/16)*2 = 0 → total 29
    expect(ctx.jitCost).toBe(29)
  })

  it('3-elem Coll → Coll[Int](0, 1, 2)', () => {
    const ctx = makeContext({})
    const items: SValue[] = [
      { kind: 'Long', value: 10n },
      { kind: 'Long', value: 20n },
      { kind: 'Long', value: 30n },
    ]
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(collOf(items, SLONG), { tag: 'SColl', elem: SLONG }),
      args: [],
      typeId: 12,
      methodId: 14,
      explicitTypeArgs: {},
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result).toEqual({
      kind: 'Coll',
      elem: SINT,
      items: [
        { kind: 'Int', value: 0 },
        { kind: 'Int', value: 1 },
        { kind: 'Int', value: 2 },
      ],
    })
    // Dispatcher 4 + Const arm 5 + handler base 20 + ceil(3/16)*2 = 2 → total 31
    expect(ctx.jitCost).toBe(31)
  })

  it('rejects when obj is not Coll', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr({ kind: 'Long', value: 5n }, SLONG),
      args: [],
      typeId: 12,
      methodId: 14,
      explicitTypeArgs: {},
    }
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface IndicesEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface IndicesFixture {
  corpus: string
  entries: IndicesEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/scoll-indices.json')
const fixture: IndicesFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SColl.indices — fixture-driven', () => {
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
