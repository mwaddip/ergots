/**
 * Layer C1 — SColl.flatMap handler (typeId 12, methodId 15). Phase 2h-f.
 *
 * Pattern B cost `addPerItemCost(60, 10, 8, n)` charged AFTER all guards.
 * Lambda HOF with concat semantics + body-restriction quirk
 * (MethodCall body must have 0 args, per sigma-rust scoll.rs:78-84) +
 * SAny-tolerant outElem with first-iter refinement.
 *
 * Source: ergotree-interpreter/src/eval/scoll.rs:52-136 — flatmap_eval
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { Env } from '../../src/eval/env'
import { evalSCollFlatMap } from '../../src/eval/scoll-flat-map'
import type { Closure, Expr, MethodCall, SType, SValue } from '../../src/mir/types'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import {
  runMutationLoop,
  DEFAULT_KILL_THRESHOLD,
} from '../_helpers/mutation-harness'

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/scoll-flat-map.json')
const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SColl.flatMap — fixture-driven (Layer C1)', () => {
  for (const entry of fixture.entries) {
    if (entry.expected_error_code !== null) {
      it(`${entry.name} throws ${entry.expected_error_code}`, () => {
        const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
        const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
        try {
          evaluateWith(tree, ctx)
          throw new Error('expected throw')
        } catch (e) {
          expect(e).toBeInstanceOf(EvalError)
          expect((e as EvalError).code).toBe(entry.expected_error_code)
        }
      })
    } else {
      it(entry.name, () => {
        const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
        const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      })
    }
  }
})

// ─── TS-direct edge cases ───────────────────────────────────────────────────
//
// These scenarios are NOT reachable via fixture-gen per T6 pre-flight:
// sigma-rust's MethodCall::new (mir/method_call.rs:90, calling new_inner at
// :41-87) performs strict structural type-matching that rejects malformed
// shapes at construction. We synthesize MethodCall MIR nodes + Closure SValues
// directly and call `evalSCollFlatMap`, bypassing the parser's type-checks.

const SLONG: SType = { tag: 'SLong' }
const SINT: SType = { tag: 'SInt' }
const SCOLL_LONG: SType = { tag: 'SColl', elem: SLONG }
const SCOLL_INT: SType = { tag: 'SColl', elem: SINT }

function longConst(value: bigint): Expr {
  return { tag: 'Const', tpe: SLONG, value: { kind: 'Long', value } }
}

function emptyCollLongConst(): Expr {
  return { tag: 'Const', tpe: SCOLL_LONG, value: { kind: 'Coll', elem: SLONG, items: [] } }
}

function buildFuncValueExpr(argTpe: SType, body: Expr): Expr {
  return {
    tag: 'FuncValue',
    args: [{ id: 1, tpe: argTpe }],
    body,
  }
}

function buildFlatMapExpr(input: Expr, lambda: Expr): MethodCall {
  return {
    tag: 'MethodCall',
    obj: input,
    typeId: 12,
    methodId: 15,
    args: [lambda],
    explicitTypeArgs: {},
  }
}

describe('SColl.flatMap — direct edge cases (R3 + reachability gaps)', () => {
  it('throws coll-input-not-coll when obj is not a Coll (no cost charged — guards before Pattern B)', () => {
    const ctx = makeContext({})
    const obj: SValue = { kind: 'Long', value: 0n }
    const closure: Closure = {
      argIds: [1],
      argTpes: [SLONG],
      body: { tag: 'Const', tpe: SLONG, value: { kind: 'Long', value: 0n } },
      capturedEnv: Env.empty(),
    }
    const lambda: SValue = { kind: 'Lambda', closure }
    const mc = buildFlatMapExpr(longConst(0n), buildFuncValueExpr(SLONG, longConst(0n)))
    expect(() => evalSCollFlatMap(obj, [lambda], ctx, {}, mc, Env.empty())).toThrow(EvalError)
    // Guards (extractCollItems) fire BEFORE the outer cost charge (Pattern B):
    // no cost should be accumulated.
    expect(ctx.jitCost).toBe(0)
  })

  it('throws lambda-not-callable when args.length !== 1 (no cost — Pattern B)', () => {
    const ctx = makeContext({})
    const obj: SValue = { kind: 'Coll', elem: SLONG, items: [] }
    const mc = buildFlatMapExpr(emptyCollLongConst(), buildFuncValueExpr(SLONG, longConst(0n)))
    expect(() => evalSCollFlatMap(obj, [], ctx, {}, mc, Env.empty())).toThrow(EvalError)
    expect(ctx.jitCost).toBe(0)
  })

  it('throws lambda-not-callable when lambda has > 1 arg (no cost — Pattern B)', () => {
    const ctx = makeContext({})
    const obj: SValue = { kind: 'Coll', elem: SLONG, items: [] }
    // Synthesize a Closure with 2 argIds (cannot construct via parser; sigma-rust
    // MethodCall::new would reject the SFunc tpe mismatch at construction).
    const closure: Closure = {
      argIds: [1, 2],
      argTpes: [SLONG, SLONG],
      body: { tag: 'Const', tpe: SCOLL_LONG, value: { kind: 'Coll', elem: SLONG, items: [] } },
      capturedEnv: Env.empty(),
    }
    const lambda: SValue = { kind: 'Lambda', closure }
    const mc = buildFlatMapExpr(emptyCollLongConst(), buildFuncValueExpr(SLONG, longConst(0n)))
    try {
      evalSCollFlatMap(obj, [lambda], ctx, {}, mc, Env.empty())
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('lambda-not-callable')
    }
    expect(ctx.jitCost).toBe(0)
  })

  it('throws coll-elem-tpe-mismatch when lambda arg tpe differs from input.elem (no cost — Pattern B)', () => {
    const ctx = makeContext({})
    const obj: SValue = { kind: 'Coll', elem: SINT, items: [] } // Coll[Int]
    // FuncValue's MIR arg tpe is SLong but input.elem is SInt.
    const closure: Closure = {
      argIds: [1],
      argTpes: [SLONG], // FuncValue MIR arg tpe SLong (mismatching SInt input.elem)
      body: { tag: 'Const', tpe: SCOLL_LONG, value: { kind: 'Coll', elem: SLONG, items: [] } },
      capturedEnv: Env.empty(),
    }
    const lambda: SValue = { kind: 'Lambda', closure }
    const mc = buildFlatMapExpr(
      { tag: 'Const', tpe: SCOLL_INT, value: { kind: 'Coll', elem: SINT, items: [] } },
      buildFuncValueExpr(SLONG, longConst(0n)), // arg tpe SLong, mismatching SInt input.elem
    )
    try {
      evalSCollFlatMap(obj, [lambda], ctx, {}, mc, Env.empty())
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('coll-elem-tpe-mismatch')
    }
    expect(ctx.jitCost).toBe(0)
  })

  it('empty input + property-call body returns Coll[SInt] (indices static return type, JVM-aligned)', () => {
    // Empty Coll[Coll[Long]] flatMap (xs: Coll[Long]) => xs.indices.
    // Body is a PropertyCall to SColl.indices (12:14); the method-signature
    // resolver gives its static return type Coll[SInt]. No iters happen on empty
    // input, but the output elem now derives from the body's STATIC type (not
    // first-iter refinement), so the result is Coll[SInt] empty — matching
    // JVM/sigma-rust `CollKind::from_vec_vec(body.tpe(), ...)`. A3 closed.
    const ctx = makeContext({})
    const obj: SValue = { kind: 'Coll', elem: SCOLL_LONG, items: [] }
    // closure.body is a PropertyCall to indices → exprTpe = Coll[SInt].
    const closure: Closure = {
      argIds: [1],
      argTpes: [SCOLL_LONG],
      body: {
        tag: 'PropertyCall',
        explicitTypeArgs: {},
        obj: { tag: 'ValUse', valId: 1, tpe: SCOLL_LONG },
        typeId: 12,
        methodId: 14, // indices
      },
      capturedEnv: Env.empty(),
    }
    const lambda: SValue = { kind: 'Lambda', closure }
    const lambdaExpr: Expr = buildFuncValueExpr(SCOLL_LONG, {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'ValUse', valId: 1, tpe: SCOLL_LONG },
      typeId: 12,
      methodId: 14,
    })
    const mc = buildFlatMapExpr(
      {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: SCOLL_LONG },
        value: { kind: 'Coll', elem: SCOLL_LONG, items: [] },
      },
      lambdaExpr,
    )
    const result = evalSCollFlatMap(obj, [lambda], ctx, {}, mc, Env.empty())
    expect(result.kind).toBe('Coll')
    // JVM-aligned: elem is the body's static return elem (SInt), even on empty input.
    expect((result as SValue & { kind: 'Coll' }).elem).toEqual({ tag: 'SInt' })
    expect((result as SValue & { kind: 'Coll' }).items.length).toBe(0)
    // Value-only fix: cost UNCHANGED. Empty input → outer cost = 60 + 10 * 1 chunk = 70
    // (n=0 ⇒ 1 chunk, Scala PerItemCost).
    expect(ctx.jitCost).toBe(70)
  })

  it('empty input + getEncoded body returns Coll[SByte] (mirrors conformance Coll()#0)', () => {
    // Empty Coll[GroupElement] flatMap (b: GroupElement) => b.getEncoded.
    // getEncoded (PropertyCall 7:2) resolves to Coll[SByte]; on empty input the
    // output elem is the body's static elem → Coll[SByte] empty. This is the
    // SANTA v5 `Coll()#0` vector's shape at the eval layer.
    const SGROUPELEMENT: SType = { tag: 'SGroupElement' }
    const SCOLL_GE: SType = { tag: 'SColl', elem: SGROUPELEMENT }
    const ctx = makeContext({})
    const obj: SValue = { kind: 'Coll', elem: SGROUPELEMENT, items: [] }
    const body: Expr = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      obj: { tag: 'ValUse', valId: 1, tpe: SGROUPELEMENT },
      typeId: 7,
      methodId: 2, // getEncoded
    }
    const closure: Closure = { argIds: [1], argTpes: [SGROUPELEMENT], body, capturedEnv: Env.empty() }
    const lambda: SValue = { kind: 'Lambda', closure }
    const lambdaExpr: Expr = buildFuncValueExpr(SGROUPELEMENT, body)
    const mc = buildFlatMapExpr(
      { tag: 'Const', tpe: SCOLL_GE, value: { kind: 'Coll', elem: SGROUPELEMENT, items: [] } },
      lambdaExpr,
    )
    const result = evalSCollFlatMap(obj, [lambda], ctx, {}, mc, Env.empty())
    expect(result.kind).toBe('Coll')
    expect((result as SValue & { kind: 'Coll' }).elem).toEqual({ tag: 'SByte' })
    expect((result as SValue & { kind: 'Coll' }).items.length).toBe(0)
    expect(ctx.jitCost).toBe(70)
  })

  it('lambda-result-type-mismatch when itemRes is not a Coll (per-element binding charged; outer structural NOT charged on body error)', () => {
    // Synthesize a closure whose body, despite static type claim SColl(SLong),
    // returns a non-Coll SValue at runtime. We do this by lying about the
    // body's static tpe (passing a Const whose runtime kind doesn't match its
    // declared tpe). exprTpe(closure.body) returns SColl(SLong) (concrete);
    // the runtime itemRes.kind !== 'Coll' triggers the per-iter type-check throw.
    const ctx = makeContext({})
    const items: SValue[] = [{ kind: 'Long', value: 1n }]
    const obj: SValue = { kind: 'Coll', elem: SLONG, items }
    // Body's static tpe (via Const.tpe) is SColl(SLong); runtime SValue is a Long.
    const malformed_body: Expr = {
      tag: 'Const',
      tpe: SCOLL_LONG,
      value: { kind: 'Long', value: 0n },
    }
    const closure: Closure = { argIds: [1], argTpes: [SLONG], body: malformed_body, capturedEnv: Env.empty() }
    const lambda: SValue = { kind: 'Lambda', closure }
    const lambdaExpr: Expr = buildFuncValueExpr(SLONG, malformed_body)
    const mc = buildFlatMapExpr(
      { tag: 'Const', tpe: SCOLL_LONG, value: { kind: 'Coll', elem: SLONG, items } },
      lambdaExpr,
    )
    try {
      evalSCollFlatMap(obj, [lambda], ctx, {}, mc, Env.empty())
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('lambda-result-type-mismatch')
    }
    // JVM charges the flatMap structural cost (PerItemCost on res.length) AFTER
    // the body evals (methods.scala:1004-1008), so a body error never reaches it.
    // Per element: ADD_TO_ENV_COST (5, lambda-arg binding) + Const body eval (5).
    // The type-mismatch throws on element 1, before the post-loop structural
    // charge → total 10, no outer. (Was 75 under the old charge-before-loop,
    // input-length, no-per-element-binding model; JVM-aligned now.)
    expect(ctx.jitCost).toBe(10)
  })
})

// ─── Mutation testing (Layer C3.a) ──────────────────────────────────────────
//
// Per Spec § R6: mutate the full tree bytes for each success-path scenario,
// using the shared runMutationLoop from phase 2h-e. Standard isKill rule
// (throw-or-diverge). Aggregate kill rate target: ≥ 0.9 per scenario.
//
// Mutation region: { start: 0, end: treeBytes.length } — broad mutation, since
// flatMap fixtures have no inline-Coll[Byte] payload to narrow to. Most bytes
// (header, MethodCall opcode, typeIds, receiver Const, lambda body) are
// load-bearing; broad mutation reliably hits ≥ 90% kill.

describe('SColl.flatMap mutation testing (Layer C3.a)', () => {
  // Only the 4 success-path scenarios participate. Throw-path entries are
  // skipped (mutation against an error baseline isn't well-defined).
  const successEntries = fixture.entries.filter((e) => e.expected_error_code === null)
  let aggKilled = 0
  let aggTotal = 0

  for (const entry of successEntries) {
    it(`${entry.name}: ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      const result = runMutationLoop({
        treeBytes,
        region: { start: 0, end: treeBytes.length },
        optsJson: entry.opts_json,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] SColl.flatMap.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)}`,
      )
      aggKilled += result.killed
      aggTotal += result.total
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }

  it(`SColl.flatMap aggregate kill rate ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG SColl.flatMap: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
