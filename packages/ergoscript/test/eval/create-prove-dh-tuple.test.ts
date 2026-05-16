/**
 * CreateProveDhTuple eval arm — fixture-driven tests (phase 2g-medium Task 4).
 *
 * Pattern A: Fixed(20) cost BEFORE eval-children (sigma-rust
 * `ergotree-interpreter/src/eval/create_prove_dh_tuple.rs:12-25`).
 *
 * Expected fixture entries:
 *   - basic: four distinct GroupElement Consts → SigmaProp{ProveDhTuple, g, h, u, v}
 *   - identity-g: g is 33-zero-byte identity; rest non-identity.
 *   - cost-limit-exceeded: tight jitCostLimit triggers 'cost-limit-exceeded'.
 *
 * Plus 4 inline TS-only error tests for per-position non-GroupElement input
 * (sigma-rust's try_build rejects at construction, so these can't be Rust-generated).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, captureEvalError, rehydrateEvalOpts } from '../_helpers'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import type { CreateProveDhTuple, Expr } from '../../src/mir/types'

interface CreateProveDhTupleEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown | null
  expected_cost: number
  expected_error_code: string | null
}

interface CreateProveDhTupleFixture {
  description: string
  entries: CreateProveDhTupleEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/create-prove-dh-tuple.json')
const fixture: CreateProveDhTupleFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('CreateProveDhTuple eval arm', () => {
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

describe('CreateProveDhTuple inline error cases', () => {
  // A valid GroupElement constant (33-byte identity point) for the "good" positions.
  const ge: Expr = {
    tag: 'Const',
    tpe: { tag: 'SGroupElement' },
    value: { kind: 'GroupElement', value: new Uint8Array(33) },
  }
  // A bad (non-GroupElement) constant — SInt 5.
  const badExpr: Expr = {
    tag: 'Const',
    tpe: { tag: 'SInt' },
    value: { kind: 'Int', value: 5 },
  }

  it("throws 'sigma-prop-input-not-group-element' when g is non-GroupElement", () => {
    const expr: CreateProveDhTuple = { tag: 'CreateProveDhTuple', g: badExpr, h: ge, u: ge, v: ge }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err?.code).toBe('sigma-prop-input-not-group-element')
  })

  it("throws 'sigma-prop-input-not-group-element' when h is non-GroupElement", () => {
    const expr: CreateProveDhTuple = { tag: 'CreateProveDhTuple', g: ge, h: badExpr, u: ge, v: ge }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err?.code).toBe('sigma-prop-input-not-group-element')
  })

  it("throws 'sigma-prop-input-not-group-element' when u is non-GroupElement", () => {
    const expr: CreateProveDhTuple = { tag: 'CreateProveDhTuple', g: ge, h: ge, u: badExpr, v: ge }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err?.code).toBe('sigma-prop-input-not-group-element')
  })

  it("throws 'sigma-prop-input-not-group-element' when v is non-GroupElement", () => {
    const expr: CreateProveDhTuple = { tag: 'CreateProveDhTuple', g: ge, h: ge, u: ge, v: badExpr }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err?.code).toBe('sigma-prop-input-not-group-element')
  })
})
