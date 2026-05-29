/**
 * SColl.patch handler (typeId 12, methodId 19) — campaign iter-28.
 *
 * `Coll[T].patch(from: Int, patch: Coll[T], replaced: Int) -> Coll[T]`
 *
 * Pattern A cost addPerItemCost(30, 2, 10, n) = 30 + ceil(n/10)*2 on the INPUT
 * length n, charged BEFORE pulling args. `from` and `replaced` are each
 * INDEPENDENTLY clamped to >=0 (max(0)), then:
 *   result = input.take(from) ++ patch ++ input.skip(from + replaced)
 * (NOT generic Scala IndexedSeq.patch — see the negative-from test below.)
 *
 * Source: ergotree-interpreter/src/eval/scoll.rs:195-236 (PATCH_EVAL_FN).
 * Method (V0+, no version gate): ergotree-ir/src/types/scoll.rs::PATCH_METHOD.
 *
 * Cost breakdown for the direct tests below (same model the scoll-zip tests use):
 *   dispatcher 4 + 4×Const 5 (=20) + handler (30 + ceil(n/10)*2).
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
const SINT: SType = { tag: 'SInt' }

function collOf(items: SValue[], elem: SType): SValue {
  return { kind: 'Coll', elem, items }
}
function constExpr(value: SValue, tpe: SType): any {
  return { tag: 'Const', tpe, value }
}
function longColl(...vals: number[]): SValue {
  return collOf(vals.map((v) => ({ kind: 'Long', value: BigInt(v) })), SLONG)
}
function patchCall(obj: SValue, from: number, patch: SValue, replaced: number): MethodCallExpr {
  return {
    tag: 'MethodCall',
    obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
    args: [
      constExpr({ kind: 'Int', value: from }, SINT),
      constExpr(patch, { tag: 'SColl', elem: SLONG }),
      constExpr({ kind: 'Int', value: replaced }, SINT),
    ],
    typeId: 12,
    methodId: 19,
    explicitTypeArgs: {},
  }
}

describe('SColl.patch handler (iter-28)', () => {
  it('clamps negative `from` to 0 independently of `replaced` (sigma-rust, NOT Scala patch)', () => {
    // [1,2,3].patch(-1, [4,5], 1): from→max(0,-1)=0, replaced=1.
    // take(0) ++ [4,5] ++ skip(0+1) = [] ++ [4,5] ++ [2,3] = [4,5,2,3].
    // A naive Scala patch would skip(-1+1)=skip(0) → [4,5,1,2,3]; this pins the divergence.
    const ctx = makeContext({})
    const result = evalMethodCall(patchCall(longColl(1, 2, 3), -1, longColl(4, 5), 1), Env.empty(), ctx)
    expect(result).toEqual(longColl(4, 5, 2, 3))
    // dispatcher 4 + 4×Const 20 + handler (30 + ceil(3/10)*2=2) → 56
    expect(ctx.jitCost).toBe(56)
  })

  it('clamps negative `replaced` to 0 independently of `from`', () => {
    // [1,2,3].patch(1, [9], -5): replaced→0. take(1) ++ [9] ++ skip(1+0) = [1] ++ [9] ++ [2,3].
    const ctx = makeContext({})
    const result = evalMethodCall(patchCall(longColl(1, 2, 3), 1, longColl(9), -5), Env.empty(), ctx)
    expect(result).toEqual(longColl(1, 9, 2, 3))
    expect(ctx.jitCost).toBe(56)
  })

  it('charges handler base 30 at n=0 (empty input)', () => {
    // [].patch(0, [7,8], 0) → [7,8]; handler 30 + ceil(0/10)*2=0.
    const ctx = makeContext({})
    const result = evalMethodCall(patchCall(longColl(), 0, longColl(7, 8), 0), Env.empty(), ctx)
    expect(result).toEqual(longColl(7, 8))
    // dispatcher 4 + 4×Const 20 + handler 30 → 54
    expect(ctx.jitCost).toBe(54)
  })

  it('saturates out-of-bounds from/replaced (take/skip semantics) and preserves elem type', () => {
    // [1,2,3].patch(9, [4,5], 9): take(9)=all ++ [4,5] ++ skip(18)=[] → [1,2,3,4,5].
    const ctx = makeContext({})
    const result = evalMethodCall(patchCall(longColl(1, 2, 3), 9, longColl(4, 5), 9), Env.empty(), ctx)
    expect(result).toEqual(longColl(1, 2, 3, 4, 5))
    expect((result as { elem: SType }).elem).toEqual(SLONG)
  })

  it('rejects when obj is not a Coll', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr({ kind: 'Long', value: 5n }, SLONG),
      args: [
        constExpr({ kind: 'Int', value: 0 }, SINT),
        constExpr(longColl(1), { tag: 'SColl', elem: SLONG }),
        constExpr({ kind: 'Int', value: 0 }, SINT),
      ],
      typeId: 12,
      methodId: 19,
      explicitTypeArgs: {},
    }
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface PatchEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface PatchFixture {
  corpus: string
  entries: PatchEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/coll-patch.json')
const fixture: PatchFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SColl.patch — fixture-driven', () => {
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
