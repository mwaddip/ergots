/**
 * SOption.map handler (typeId 36, methodId 7) — campaign iter-29.
 *
 * `Option[T].map(f: T => R): Option[R]` — lambda HOF.
 *
 * Fixed cost 20 (Pattern A, charged first). `Some(t)` → `Some(lambda(t))`;
 * `None` → `None`. Lambda invocation mirrors SColl.flatMap's env-extend.
 * Result Option elem type = exprTpe(lambda body). V0 (no version gate).
 *
 * Source: ergotree-interpreter/src/eval/soption.rs:13-60 (map_eval).
 *
 * Fixtures build the receiver as `ExtractRegisterAs(box, R4, Option[T]).map(f)`
 * (an Option Constant can't be sigma-serialized; Options arise from operations).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeContext } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import { evalSOptionMap } from '../../src/eval/soption-map'
import { Env } from '../../src/eval/env'
import type { SValue, Expr, SType } from '../../src/mir/types'

interface MapEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface MapFixture {
  corpus: string
  entries: MapEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/soption-map.json')
const fixture: MapFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SOption.map — fixture-driven', () => {
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

// ---------------------------------------------------------------------------
// F3.5 cost-pin: ADD_TO_ENV_COST(5) on lambda invocation for Some-path.
// Route A: direct evalSOptionMap call with hand-built closure.
//
// Decomposition for Some-path (obj = Some(Int 5), body = Const Int 7):
//   20  MapMethod fixed cost (Pattern A)
//    5  ADD_TO_ENV_COST on lambda arg-binding (F3.5 fix; same class as
//       apply.ts:74 and scoll-flat-map.ts:139 per-element charge)
//    5  Const body eval
//  ---
//   30  total
//
// None-path: fixed cost 20 only — lambda never invoked, ADD_TO_ENV not charged.
// ---------------------------------------------------------------------------
describe('SOption.map — F3.5 ADD_TO_ENV cost pin (direct handler)', () => {
  const SINT: SType = { tag: 'SInt' }
  const constBody: Expr = { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: 7 } }

  function makeClosure(): SValue {
    return {
      kind: 'Lambda',
      closure: {
        argIds: [1],
        argTpes: [SINT],
        body: constBody,
        capturedEnv: Env.empty(),
      },
    }
  }

  it('Some-path: total cost 30 (20 map + 5 ADD_TO_ENV + 5 body Const)', () => {
    const ctx = makeContext({})
    const obj: SValue = { kind: 'Option', elem: SINT, value: { kind: 'Int', value: 5 } }
    const result = evalSOptionMap(obj, [makeClosure()], ctx, Env.empty())
    expect(result).toEqual({ kind: 'Option', elem: SINT, value: { kind: 'Int', value: 7 } })
    expect(ctx.jitCost).toBe(30)
  })

  it('None-path: total cost 20 (fixed only — lambda not invoked)', () => {
    const ctx = makeContext({})
    const obj: SValue = { kind: 'Option', elem: SINT, value: null }
    const result = evalSOptionMap(obj, [makeClosure()], ctx, Env.empty())
    expect(result).toEqual({ kind: 'Option', elem: SINT, value: null })
    expect(ctx.jitCost).toBe(20)
  })
})
