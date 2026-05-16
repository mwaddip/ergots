/**
 * P2PK short-circuit smoking-gun (phase 2g-medium Task 3).
 *
 * A bare `Const(SSigmaProp, ProveDlog(pk))` tree must evaluate with
 * total JitCost = 50 (sigma-rust's EVAL_SIGMA_PROP_CONSTANT), NOT 5
 * (the standard Const charge).
 *
 * Source: ergotree-interpreter/src/eval.rs:138-158 — trivial_reduce short-circuit.
 * Implementation: evalConst adds an extra 45 when value.kind === 'SigmaProp'
 * (total = 5 + 45 = 50). Same charge for ConstPlaceholder resolving to SigmaProp.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue } from '../_helpers'

interface P2pkEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface P2pkFixture {
  description: string
  entries: P2pkEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/p2pk-short-circuit.json')
const fixture: P2pkFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('P2PK short-circuit (Const(SSigmaProp, _) = 50 JitCost)', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({})
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
      expect(ctx.jitCost).toBe(50) // sanity check: locks the EVAL_SIGMA_PROP_CONSTANT charge
    })
  }
})
