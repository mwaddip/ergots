/**
 * Layer C1 — SColl.zip handler (typeId 12, methodId 29).
 *
 * Pattern B cost addPerItemCost(10, 1, 10, n) where n = obj len (NOT min).
 * Truncates to the shorter Coll (Rust Iterator::zip semantics).
 * Returns Coll[STuple[T1, T2]].
 *
 * Source: ergotree-interpreter/src/eval/scoll.rs:138-169
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
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

const SLONG: SType = { tag: 'SLong' }
const SBYTE: SType = { tag: 'SByte' }

function collOf(items: SValue[], elem: SType): SValue {
  return { kind: 'Coll', elem, items }
}

function constExpr(value: SValue, tpe: SType): any {
  return { tag: 'Const', tpe, value }
}

describe('SColl.zip handler (Layer C1)', () => {
  it('empty zip empty → empty Coll[(Long, Long)]', () => {
    const ctx = makeContext({})
    const obj = collOf([], SLONG)
    const arg = collOf([], SLONG)
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result).toEqual({
      kind: 'Coll',
      elem: { tag: 'STuple', items: [SLONG, SLONG] },
      items: [],
    })
    // Dispatcher 4 + Const(obj) 5 + Const(arg) 5 + handler: base 10 + n=0 ⇒ 1 chunk ×1 = 11 → total 25
    expect(ctx.jitCost).toBe(25)
  })

  it('equal-length zip → tuples of corresponding elements', () => {
    const ctx = makeContext({})
    const obj = collOf(
      [
        { kind: 'Long', value: 1n },
        { kind: 'Long', value: 2n },
        { kind: 'Long', value: 3n },
      ],
      SLONG
    )
    const arg = collOf(
      [
        { kind: 'Long', value: 10n },
        { kind: 'Long', value: 20n },
        { kind: 'Long', value: 30n },
      ],
      SLONG
    )
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result).toEqual({
      kind: 'Coll',
      elem: { tag: 'STuple', items: [SLONG, SLONG] },
      items: [
        { kind: 'Tuple', items: [{ kind: 'Long', value: 1n }, { kind: 'Long', value: 10n }] },
        { kind: 'Tuple', items: [{ kind: 'Long', value: 2n }, { kind: 'Long', value: 20n }] },
        { kind: 'Tuple', items: [{ kind: 'Long', value: 3n }, { kind: 'Long', value: 30n }] },
      ],
    })
    // Dispatcher 4 + Const(obj) 5 + Const(arg) 5 + handler: base 10 + ceil(3/10)*1=1 → total 25
    expect(ctx.jitCost).toBe(25)
  })

  it('short obj zip long arg → truncates to obj length', () => {
    const ctx = makeContext({})
    const obj = collOf([{ kind: 'Long', value: 1n }], SLONG)
    const arg = collOf(
      [
        { kind: 'Long', value: 10n },
        { kind: 'Long', value: 20n },
      ],
      SLONG
    )
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect((result as any).items).toHaveLength(1)
    // n = obj len = 1; Dispatcher 4 + Const(obj) 5 + Const(arg) 5 + handler: 10 + ceil(1/10)*1=1 → 25
    expect(ctx.jitCost).toBe(25)
  })

  it('long obj zip short arg → truncates to arg length', () => {
    const ctx = makeContext({})
    const obj = collOf(
      [
        { kind: 'Long', value: 1n },
        { kind: 'Long', value: 2n },
      ],
      SLONG
    )
    const arg = collOf([{ kind: 'Long', value: 10n }], SLONG)
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect((result as any).items).toHaveLength(1)
    // n = obj len = 2; Dispatcher 4 + Const(obj) 5 + Const(arg) 5 + handler: 10 + ceil(2/10)*1=1 → 25
    expect(ctx.jitCost).toBe(25)
  })

  it('mixed-type zip → tuples of (Long, Byte)', () => {
    const ctx = makeContext({})
    const obj = collOf(
      [{ kind: 'Long', value: 100n }, { kind: 'Long', value: 200n }],
      SLONG
    )
    const arg = collOf(
      [{ kind: 'Byte', value: 1 }, { kind: 'Byte', value: 2 }],
      SBYTE
    )
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SBYTE })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect((result as any).elem).toEqual({ tag: 'STuple', items: [SLONG, SBYTE] })
    expect((result as any).items).toHaveLength(2)
    // n = obj len = 2; same cost as above → 25
    expect(ctx.jitCost).toBe(25)
  })

  it('rejects when obj is not Coll', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr({ kind: 'Long', value: 5n }, SLONG),
      args: [constExpr(collOf([], SLONG), { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
    }
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })

  it('rejects when arg is not Coll', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(collOf([], SLONG), { tag: 'SColl', elem: SLONG }),
      args: [constExpr({ kind: 'Long', value: 5n }, SLONG)],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
    }
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface ZipEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface ZipFixture {
  corpus: string
  entries: ZipEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/scoll-zip.json')
const fixture: ZipFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SColl.zip — fixture-driven', () => {
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
