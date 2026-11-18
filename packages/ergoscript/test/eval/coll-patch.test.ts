/**
 * SColl.patch handler (typeId 12, methodId 19).
 *
 * `Coll[T].patch(from: Int, patch: Coll[T], replaced: Int) -> Coll[T]`
 *
 * The method's descriptor lives at
 * `data/shared/src/main/scala/sigma/ast/methods.scala:1013-1031` at 6.0.7:
 * `PerItemCost(30, 2, 10)` on `nItems = xs.length + patch.length`, charged
 * at the head of the body through `addSeqCost` (`methods.scala:1028`). The
 * body is `core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:94-98`
 * for an array receiver and `:423-428` for a pair receiver, with `from` and
 * `replaced` each clamped to `>= 0` as Scala's `Array.patch` does. V0+ (no
 * version gate).
 *
 * Cost breakdown for the direct tests below:
 *   dispatcher 4 + 4 × Const 5 (= 20) + handler (30 + chunks * 2),
 * where `chunks = (nItems - 1) / 10 + 1` (`core/shared/src/main/scala/sigma/
 * ast/CostKind.scala:24`).
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
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, withoutClass } from '../_helpers'
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

const SLONG: SType = { tag: 'SLong' }
const SINT: SType = { tag: 'SInt' }
const SBYTE: SType = { tag: 'SByte' }

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
  it('clamps negative `from` to 0 independently of `replaced` (Scala Array.patch semantics)', () => {
    // [1,2,3].patch(-1, [4,5], 1): from→max(0,-1)=0, replaced=1.
    // take(0) ++ [4,5] ++ skip(0+1) = [] ++ [4,5] ++ [2,3] = [4,5,2,3].
    const ctx = makeContext({})
    const result = evalMethodCall(patchCall(longColl(1, 2, 3), -1, longColl(4, 5), 1), Env.empty(), ctx)
    expect(withoutClass(result)).toEqual(longColl(4, 5, 2, 3))
    // dispatcher 4 + 4×Const 20 + handler (30 + chunks(xs=3 + patch=2 = 5)*2 = 32) → 56
    expect(ctx.jitCost).toBe(56)
  })

  it('clamps negative `replaced` to 0 independently of `from`', () => {
    // [1,2,3].patch(1, [9], -5): replaced→0. take(1) ++ [9] ++ skip(1+0) = [1] ++ [9] ++ [2,3].
    const ctx = makeContext({})
    const result = evalMethodCall(patchCall(longColl(1, 2, 3), 1, longColl(9), -5), Env.empty(), ctx)
    expect(withoutClass(result)).toEqual(longColl(1, 9, 2, 3))
    expect(ctx.jitCost).toBe(56)
  })

  it('charges handler base 30 at nItems = 0 + patchLen (empty input)', () => {
    // [].patch(0, [7,8], 0) → [7,8]; nItems = 0 + 2 = 2, chunks = 1, handler 30+2 = 32.
    const ctx = makeContext({})
    const result = evalMethodCall(patchCall(longColl(), 0, longColl(7, 8), 0), Env.empty(), ctx)
    expect(withoutClass(result)).toEqual(longColl(7, 8))
    // dispatcher 4 + 4×Const 20 + handler 32 → 56
    expect(ctx.jitCost).toBe(56)
  })

  it('saturates out-of-bounds from/replaced (take/skip semantics) and preserves elem type', () => {
    // [1,2,3].patch(9, [4,5], 9): take(9)=all ++ [4,5] ++ skip(18)=[] → [1,2,3,4,5].
    const ctx = makeContext({})
    const result = evalMethodCall(patchCall(longColl(1, 2, 3), 9, longColl(4, 5), 9), Env.empty(), ctx)
    expect(withoutClass(result)).toEqual(longColl(1, 2, 3, 4, 5))
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

// Cost on nItems = xs.length + patch.length
// (`data/shared/src/main/scala/sigma/ast/methods.scala:1024-1030` at 6.0.7).
// `PerItemCost.cost(n) = base + perChunk * ((n - 1) / chunkSize + 1)`
// (`core/shared/src/main/scala/sigma/ast/CostKind.scala:24`), so chunks go
// from 1 to 2 at nItems = 11. An implementation that counts the receiver
// alone would charge one chunk less on a row where the receiver is at most
// 10 and the sum is 11 or more; each row below pins that chunk-boundary
// behaviour through the evaluator.
//
// Per-row total: dispatcher 4 + 4 × Const 5 (= 20) + handler (30 + chunks * 2).
describe("SColl.patch handler — cost counts the receiver and the patch across a chunk boundary", () => {
  it("receiver 8 + patch 3 (nItems 11, chunks 2): handler 34, total 58 — receiver alone (chunks 1) charges 56", () => {
    // nItems = 8 + 3 = 11 → chunks = (11 - 1) / 10 + 1 = 2 → handler 30 + 2 * 2 = 34.
    // Total = 4 + 20 + 34 = 58. The sum crosses the boundary that the receiver (8) does not.
    const ctx = makeContext({})
    const recv = longColl(1, 2, 3, 4, 5, 6, 7, 8)
    const result = evalMethodCall(
      patchCall(recv, 0, longColl(9, 10, 11), 0),
      Env.empty(),
      ctx,
    )
    expect(withoutClass(result)).toEqual(longColl(9, 10, 11, 1, 2, 3, 4, 5, 6, 7, 8))
    expect(ctx.jitCost).toBe(58)
  })

  it("receiver 10 + EMPTY patch (nItems 10, chunks 1): handler 32, total 56", () => {
    // nItems = 10 + 0 = 10 → chunks = (10 - 1) / 10 + 1 = 1 → handler 30 + 1 * 2 = 32.
    // Total = 4 + 20 + 32 = 56.
    const ctx = makeContext({})
    const recv = longColl(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    const result = evalMethodCall(
      patchCall(recv, 0, longColl(), 0),
      Env.empty(),
      ctx,
    )
    expect(withoutClass(result)).toEqual(recv)
    expect(ctx.jitCost).toBe(56)
  })

  it("receiver 10 + patch 1 (nItems 11, chunks 2): handler 34, total 58 — the chunk-boundary row", () => {
    // nItems = 10 + 1 = 11 → chunks = 2 → handler 34; total 4 + 20 + 34 = 58.
    // Same receiver (10) as the EMPTY-patch case above; the patch's one item
    // moves nItems over the boundary.
    const ctx = makeContext({})
    const recv = longColl(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    const result = evalMethodCall(
      patchCall(recv, 0, longColl(99), 0),
      Env.empty(),
      ctx,
    )
    expect(withoutClass(result)).toEqual(longColl(99, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
    expect(ctx.jitCost).toBe(58)
  })

  it("refused patch of another class on a specialised Coll[Byte] receiver: ctx.jitCost holds handler 34 at the catch", () => {
    // Specialised Coll[Byte] receiver (data reader's class for SByte is
    // specialised byte, `CollsOverArrays.scala:11` with the `@specialized`
    // CollOverArray subclass; mirrored by the module's `dataClass(SByte)`),
    // Coll[Int] patch. nItems = 8 + 3 = 11 → chunks = 2 → handler 34. The
    // addPerItemCost call is settled on the context first, then the body
    // casts Array[Int] to Array[Byte] and throws 'coll-class-cast'
    // (`CollsOverArrays.scala:94-98`). ctx.jitCost at the catch =
    // 4 + 20 + 34 = 58, reading the cost that was charged, not rolled back
    // (the facts/ergoscript-eval.md evaluateWith postcondition).
    const ctx = makeContext({})
    const recv: SValue = {
      kind: 'Coll',
      elem: SBYTE,
      items: [1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ kind: 'Byte', value: v })),
    }
    const p: SValue = {
      kind: 'Coll',
      elem: SINT,
      items: [1, 2, 3].map((v) => ({ kind: 'Int', value: v })),
    }
    const node: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(recv, { tag: 'SColl', elem: SBYTE }),
      args: [
        constExpr({ kind: 'Int', value: 0 }, SINT),
        constExpr(p, { tag: 'SColl', elem: SINT }),
        constExpr({ kind: 'Int', value: 0 }, SINT),
      ],
      typeId: 12,
      methodId: 19,
      explicitTypeArgs: {},
    }
    let caught: EvalError | undefined
    try {
      evalMethodCall(node, Env.empty(), ctx)
    } catch (err) {
      caught = err as EvalError
    }
    expect(caught).toBeInstanceOf(EvalError)
    expect(caught?.code).toBe('coll-class-cast')
    expect(ctx.jitCost).toBe(58)
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
      expect(withoutClass(value)).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
