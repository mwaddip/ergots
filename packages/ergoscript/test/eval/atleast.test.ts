/**
 * Atleast eval arm — fixture-driven tests (phase 2g-combinators Task 4).
 *
 * Pattern B: addPerItemCost(20, 3, 5, n) AFTER eval-children.
 * Source: ergotree-interpreter/src/eval/atleast.rs:19-58
 *
 * Fixture entries:
 *   - atleast_2_of_3: 2-of-3 ProveDlogs → Cthreshold(2, [P,Q,R])
 *   - atleast_0_of_3_true: k=0 → TrivialProp(true)
 *   - atleast_1_of_3_cor: k=1 of 3 → Cor([P,Q,R])
 *   - atleast_3_of_3_cand: k=3 of 3 → Cand([P,Q,R])
 *   - atleast_2_of_2_cand: k=2 of 2 → Cand([P,Q])
 *   - atleast_2_of_3_with_true_child: k=2, TrivialTrue absorbed → Cor([P,Q])
 *   - atleast_2_of_3_with_false_child: k=2, TrivialFalse skipped → Cand([P,Q])
 *   - atleast_cost_limit_exceeded: tight limit → 'cost-limit-exceeded'
 *   - atleast_bound_exceeds_input_len: k=4 of 3 → TrivialProp(false) [JVM-faithful: bound>size reduces, not errors]
 *
 * Inline-only error cases (not expressible via sigma-rust tree construction):
 *   - non-Int bound → 'atleast-bound-not-int'
 *   - non-Coll input → 'sigma-prop-input-not-coll'
 *   - >255 children → 'atleast-too-many-children' (F5 batch 4)
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { hexToBytes, hydrateSValue, captureEvalError, rehydrateEvalOpts } from '../_helpers'
import type { Atleast } from '../../src/mir/types'

interface AtleastEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown | null
  expected_cost: number
  expected_error_code: string | null
}

interface AtleastFixture {
  description: string
  entries: AtleastEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/atleast.json')
const fixture: AtleastFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('Atleast eval arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))

      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err?.code).toBe(entry.expected_error_code)
        return
      }

      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

// ---------------------------------------------------------------------------
// Inline TS-only error tests — defensive codes for shapes that sigma-rust's
// Atleast::new rejects at construction time (unreachable from parser-produced
// trees; tested here for robustness against ConstantPlaceholder injection).
// ---------------------------------------------------------------------------

describe('Atleast eval arm — inline error cases', () => {
  it('throws atleast-bound-not-int when bound evaluates to non-Int', () => {
    // Hand-build Atleast node with a Boolean Const as bound (not Int).
    const mirNode: Atleast = {
      tag: 'Atleast',
      bound: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SSigmaProp' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SSigmaProp' },
          items: [],
        },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(mirNode, Env.empty(), ctx))
    expect(err.code).toBe('atleast-bound-not-int')
  })

  it('throws sigma-prop-input-not-coll when input evaluates to non-Coll', () => {
    // Hand-build Atleast node with an Int Const as input (not Coll).
    const mirNode: Atleast = {
      tag: 'Atleast',
      bound: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 2 },
      },
      input: {
        tag: 'Const',
        tpe: { tag: 'SInt' },
        value: { kind: 'Int', value: 42 },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(mirNode, Env.empty(), ctx))
    expect(err.code).toBe('sigma-prop-input-not-coll')
  })
})

// ---------------------------------------------------------------------------
// 255-children cap (F5 batch 4, member C)
// JVM order: charge Pattern-B cost → cap-throw → degenerate reductions.
// CSigmaDslBuilder.atLeast (CSigmaDslBuilder.scala:102-108) throws BEFORE
// AtLeast.reduce (trees.scala:340-359), so atLeast(bound≤0, >255 children)
// THROWS — it does NOT reduce to TrivialProp(true).
// ---------------------------------------------------------------------------

describe('Atleast 255-children cap (F5 batch 4)', () => {
  // Build an Atleast node with n TrivialProp children and the given Int bound.
  // Mirrors the inline-error-case Const construction idiom above.
  const atleastOf = (bound: number, n: number): Atleast => ({
    tag: 'Atleast',
    bound: {
      tag: 'Const',
      tpe: { tag: 'SInt' },
      value: { kind: 'Int', value: bound },
    },
    input: {
      tag: 'Const',
      tpe: { tag: 'SColl', elem: { tag: 'SSigmaProp' } },
      value: {
        kind: 'Coll',
        elem: { tag: 'SSigmaProp' },
        items: Array.from({ length: n }, (_, i) => ({
          kind: 'SigmaProp' as const,
          value: { tag: 'TrivialProp' as const, value: i % 2 === 0 },
        })),
      },
    },
  })

  it('256 children, bound 0 → throws (cap precedes degenerate TrueProp)', () => {
    const err = captureEvalError(() => evalExpr(atleastOf(0, 256), Env.empty(), makeContext()))
    expect(err.code).toBe('atleast-too-many-children')
  })

  it('256 children, bound 1 → throws', () => {
    const err = captureEvalError(() => evalExpr(atleastOf(1, 256), Env.empty(), makeContext()))
    expect(err.code).toBe('atleast-too-many-children')
  })

  it('256 children, bound 300 → throws (cap precedes degenerate FalseProp)', () => {
    const err = captureEvalError(() => evalExpr(atleastOf(300, 256), Env.empty(), makeContext()))
    expect(err.code).toBe('atleast-too-many-children')
  })

  it('255 children, bound 0 → TrivialProp(true) (cap is exclusive)', () => {
    const out = evalExpr(atleastOf(0, 255), Env.empty(), makeContext())
    expect(out).toEqual({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } })
  })

  it('charges the Pattern-B per-item cost before throwing', () => {
    const ctx = makeContext()
    captureEvalError(() => evalExpr(atleastOf(0, 256), Env.empty(), ctx))
    // Two Const children each cost 5 (evalConst Fixed(5)), plus
    // per-item(20, 3, 5, 256): base=20, chunks=ceil(256/5)=52, total=20+52*3=176.
    // Grand total = 5 (bound Const) + 5 (input Const) + 176 = 186.
    expect(ctx.jitCost).toBeGreaterThanOrEqual(176)
  })
})
