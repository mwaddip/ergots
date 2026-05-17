/**
 * Layer C1 — `SigmaPropBytes` Expr arm.
 *
 * Pattern A cost: addPerItemCost(35, 6, 1, 1) BEFORE eval-children.
 * Returns Coll[Byte] = SigmaBoolean.prop_bytes() serialization.
 * Source: ergotree-interpreter/src/eval/sigma_prop_bytes.rs:9-24.
 *
 * Fixture entries (cross-validated byte-for-byte against sigma-rust):
 *   trivial_true     — TrivialProp(true)  → 2-byte Coll[Byte]
 *   trivial_false    — TrivialProp(false) → 2-byte Coll[Byte]
 *   prove_dlog       — ProveDlog          → 34-byte Coll[Byte]
 *   cand_2_leaves    — Cand(P,Q)          → Coll[Byte]
 *   cor_2_leaves     — Cor(P,Q)           → Coll[Byte]
 *
 * Inline-only error case:
 *   non-SigmaProp input → 'sigma-prop-bytes-input-not-sigma-prop'
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { evalSigmaPropBytes } from '../../src/eval/sigma-prop-bytes'
import { Env } from '../../src/eval/env'
import { hexToBytes, hydrateSValue, captureEvalError, rehydrateEvalOpts } from '../_helpers'
import type { SigmaPropBytes } from '../../src/mir/types'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface SigmaPropBytesEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface SigmaPropBytesFixture {
  description: string
  entries: SigmaPropBytesEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sigma-prop-bytes.json')
const fixture: SigmaPropBytesFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

// ---------------------------------------------------------------------------
// Fixture-driven tests — sigma-rust is the oracle for value + cost.
// ---------------------------------------------------------------------------

describe('SigmaPropBytes eval arm — fixture-driven', () => {
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
// Inline TS-only error test — input evaluates to non-SigmaProp.
// This is unreachable for parser-produced trees (OneArgOpTryBuild checks
// post_eval_tpe at construction) but is tested here for defensive robustness.
// ---------------------------------------------------------------------------

describe('SigmaPropBytes eval arm — defensive throws', () => {
  it("throws 'sigma-prop-bytes-input-not-sigma-prop' when input evaluates to non-SigmaProp", () => {
    // Build a SigmaPropBytes Expr whose input is a Const(SBoolean, true) — not SigmaProp.
    const e: SigmaPropBytes = {
      tag: 'SigmaPropBytes',
      input: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalSigmaPropBytes(e, Env.empty(), ctx))
    expect(err.code).toBe('sigma-prop-bytes-input-not-sigma-prop')
    expect(err.message).toContain('SigmaProp')
  })
})
