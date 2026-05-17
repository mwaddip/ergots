/**
 * SigmaAnd eval arm — fixture-driven tests (phase 2g-combinators Task 5).
 *
 * Pattern A: addPerItemCost(10, 2, 1, n) BEFORE eval-children.
 * Source: ergotree-interpreter/src/eval/sigma_and.rs:19
 *
 * MIR shape: SigmaAnd { items: Expr[] } — each item individually evaluated,
 * each must be a SigmaProp. Result: candNormalized(items).
 *
 * Fixture entries:
 *   - sigma_and_2_leaf: 2-leaf ProveDlogs → Cand([P,Q])
 *   - sigma_and_3_leaf: 3-leaf ProveDlogs → Cand([P,Q,R])
 *   - sigma_and_5_leaf: 5-leaf ProveDlogs → Cand([P,Q,R,S,T])
 *   - sigma_and_true_absorbed: [T,P,Q] → Cand([P,Q]) (TrivialTrue identity)
 *   - sigma_and_false_absorbing: [F,P,Q] → TrivialProp(false) (absorbing)
 *   - sigma_and_single_after_filter: [T,P] → P (unwrapped single)
 *   - sigma_and_empty_after_filter: [T,T] → TrivialProp(true)
 *   - sigma_and_mixed_dlog_dhtuple: [P,DH] → Cand([P,DH])
 *   - sigma_and_cost_limit_exceeded: tight limit → 'cost-limit-exceeded'
 *
 * Inline-only error cases (not expressible via sigma-rust SigmaAnd::new):
 *   - non-SigmaProp item → 'sigma-prop-coll-elem-not-sigma-prop'
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
import type { SigmaAnd } from '../../src/mir/types'

interface SigmaAndEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown | null
  expected_cost: number
  expected_error_code: string | null
}

interface SigmaAndFixture {
  description: string
  entries: SigmaAndEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sigma-and.json')
const fixture: SigmaAndFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SigmaAnd eval arm — fixture-driven', () => {
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
// Inline TS-only error tests — defensive code for shapes that sigma-rust's
// SigmaAnd::new rejects at construction time (unreachable from parser-produced
// trees; tested here for robustness against ConstantPlaceholder injection).
// ---------------------------------------------------------------------------

describe('SigmaAnd eval arm — inline error cases', () => {
  it('throws sigma-prop-coll-elem-not-sigma-prop when an item evaluates to non-SigmaProp', () => {
    // Hand-build SigmaAnd node with an Int Const as one item (not SigmaProp).
    const mirNode: SigmaAnd = {
      tag: 'SigmaAnd',
      items: [
        {
          tag: 'Const',
          tpe: { tag: 'SInt' },
          value: { kind: 'Int', value: 42 },
        },
        {
          tag: 'Const',
          tpe: { tag: 'SInt' },
          value: { kind: 'Int', value: 7 },
        },
      ],
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(mirNode, Env.empty(), ctx))
    expect(err.code).toBe('sigma-prop-coll-elem-not-sigma-prop')
  })
})
