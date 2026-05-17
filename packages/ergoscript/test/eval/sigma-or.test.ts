/**
 * SigmaOr eval arm — fixture-driven tests (phase 2g-combinators Task 6).
 *
 * Pattern A: addPerItemCost(10, 2, 1, n) BEFORE eval-children.
 * Source: ergotree-interpreter/src/eval/sigma_or.rs:19
 *
 * MIR shape: SigmaOr { items: Expr[] } — each item individually evaluated,
 * each must be a SigmaProp. Result: corNormalized(items).
 *
 * Absorbing/identity SWAPPED vs SigmaAnd:
 *   TrivialProp(true)  → absorbing (OR short-circuits to true)
 *   TrivialProp(false) → identity (filtered out of OR)
 *
 * Fixture entries:
 *   - sigma_or_2_leaf: 2-leaf ProveDlogs → Cor([P,Q])
 *   - sigma_or_3_leaf: 3-leaf ProveDlogs → Cor([P,Q,R])
 *   - sigma_or_5_leaf: 5-leaf ProveDlogs → Cor([P,Q,R,S,T])
 *   - sigma_or_false_absorbed: [F,P,Q] → Cor([P,Q]) (TrivialFalse identity)
 *   - sigma_or_true_absorbing: [T,P,Q] → TrivialProp(true) (absorbing)
 *   - sigma_or_single_after_filter: [F,P] → P (unwrapped single)
 *   - sigma_or_empty_after_filter: [F,F] → TrivialProp(false)
 *   - sigma_or_mixed_dlog_dhtuple: [P,DH] → Cor([P,DH])
 *   - sigma_or_cost_limit_exceeded: tight limit → 'cost-limit-exceeded'
 *
 * Inline-only error cases (not expressible via sigma-rust SigmaOr::new):
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
import type { SigmaOr } from '../../src/mir/types'

interface SigmaOrEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown | null
  expected_cost: number
  expected_error_code: string | null
}

interface SigmaOrFixture {
  description: string
  entries: SigmaOrEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sigma-or.json')
const fixture: SigmaOrFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SigmaOr eval arm — fixture-driven', () => {
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
// SigmaOr::new rejects at construction time (unreachable from parser-produced
// trees; tested here for robustness against ConstantPlaceholder injection).
// ---------------------------------------------------------------------------

describe('SigmaOr eval arm — inline error cases', () => {
  it('throws sigma-prop-coll-elem-not-sigma-prop when an item evaluates to non-SigmaProp', () => {
    // Hand-build SigmaOr node with an Int Const as one item (not SigmaProp).
    const mirNode: SigmaOr = {
      tag: 'SigmaOr',
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
