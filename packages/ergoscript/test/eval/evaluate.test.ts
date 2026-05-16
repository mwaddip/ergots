import { describe, it, expect } from 'vitest'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { ErgoTree } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

// ---- helpers for auto-derive tests ----

/**
 * A V3 tree whose body is a BigInt → BigInt Upcast (a same-kind no-op that
 * sigma-rust allows only when tree_version >= V3).
 * header.version is explicitly set to 3 so evaluate() auto-derives
 * treeVersion=3, which is the contract under test.
 */
const treeV3BigIntNoop = (): ErgoTree => ({
  header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
  constantTypes: [],
  constants: [],
  body: {
    tag: 'Upcast',
    input: {
      tag: 'Const',
      tpe: { tag: 'SBigInt' },
      value: { kind: 'BigInt', value: 42n },
    },
    tpe: { tag: 'SBigInt' },
  },
})

const treeWithConstBody = (): ErgoTree => ({
  header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
  constantTypes: [],
  constants: [],
  body: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
})

// A tree whose body is an unported variant — `Exists`. `Fold` was wired
// in Task 8 (phase 2f Coll HOFs), so it no longer falls through to
// `not-implemented-yet`. `Exists` is the next unwired Coll HOF arm and
// keeps falling through until its own per-arm task lands.
const treeWithExistsBody = (): ErgoTree => {
  const innerColl = {
    tag: 'Const' as const,
    tpe: { tag: 'SColl' as const, elem: { tag: 'SInt' as const } },
    value: { kind: 'Coll' as const, elem: { tag: 'SInt' as const }, items: [] },
  }
  const conditionExpr = {
    tag: 'Const' as const,
    tpe: { tag: 'SBoolean' as const },
    value: { kind: 'Boolean' as const, value: true },
  }
  return {
    header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
    constantTypes: [],
    constants: [],
    body: { tag: 'Exists', input: innerColl, condition: conditionExpr },
  }
}

describe('evaluate', () => {
  it('routes through dispatch — Const body returns the literal and charges 5', () => {
    const tree = treeWithConstBody()
    const ctx = makeContext()
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'Int', value: 42 })
    expect(ctx.jitCost).toBe(5)
  })

  it('accepts EvalOpts with jitCostLimit + constants and still produces the value', () => {
    const value = evaluate(treeWithConstBody(), { jitCostLimit: 1000, constants: [] })
    expect(value).toEqual({ kind: 'Int', value: 42 })
  })

  it('honors jitCostLimit — throws cost-limit-exceeded when the per-Const charge of 5 overflows', () => {
    // Limit < 5 forces the very first add to overshoot.
    const err = captureEvalError(() => evaluate(treeWithConstBody(), { jitCostLimit: 4 }))
    expect(err.code).toBe('cost-limit-exceeded')
  })

  it('still throws not-implemented-yet for variants with no arm wired (e.g. Exists)', () => {
    const err = captureEvalError(() => evaluate(treeWithExistsBody()))
    expect(err.code).toBe('not-implemented-yet')
  })
})

describe('evaluateWith', () => {
  it('takes a pre-built EvalContext (caller can inspect ctx.jitCost after)', () => {
    const ctx = makeContext()
    const value = evaluateWith(treeWithConstBody(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 42 })
    expect(ctx.jitCost).toBe(5)
  })

  it('leaves ctx.jitCost at 0 if dispatch throws before any addCost runs (Exists not yet wired)', () => {
    const ctx = makeContext()
    expect(() => evaluateWith(treeWithExistsBody(), ctx)).toThrow(EvalError)
    expect(ctx.jitCost).toBe(0)
  })
})

describe('evaluate() — auto-derive treeVersion from tree.header.version', () => {
  // These tests verify the primary public contract of the treeVersion
  // plumbing introduced in phase 2e task 1:
  //   ctx.treeVersion = opts.treeVersion ?? tree.header.version
  // Every fixture-driven Upcast/Downcast test uses evaluateWith() +
  // makeContext({ treeVersion: X }), which bypasses this code path entirely.
  // The two tests below exercise it directly.

  it('derives treeVersion=3 from header and unlocks BigInt → BigInt Upcast', () => {
    // tree.header.version === 3; no opts.treeVersion supplied.
    // evaluate() should auto-derive ctx.treeVersion=3, which satisfies the
    // V3 gate in the Upcast arm (BigInt → BigInt same-kind no-op).
    const tree = treeV3BigIntNoop()
    expect(tree.header.version).toBe(3)
    // Must not throw — V3 satisfies the gate.
    expect(() => evaluate(tree, {})).not.toThrow()
  })

  it('explicit opts.treeVersion overrides header.version (V3 tree forced to V0)', () => {
    // tree.header.version === 3, but caller passes opts.treeVersion=0.
    // The explicit opts value wins; the V3 gate fires and evaluate() throws.
    const tree = treeV3BigIntNoop()
    const err = captureEvalError(() => evaluate(tree, { treeVersion: 0 }))
    expect(err.code).toBe('tree-version-too-low')
  })
})
