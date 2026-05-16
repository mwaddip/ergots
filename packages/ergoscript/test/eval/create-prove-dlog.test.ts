/**
 * CreateProveDlog eval arm — fixture-driven tests (phase 2g-medium Task 3).
 *
 * Pattern A: Fixed(10) cost BEFORE eval-child (sigma-rust
 * `ergotree-interpreter/src/eval/create_provedlog.rs:10-29`).
 *
 * Expected fixture entries:
 *   - basic: GroupElement Const → SigmaProp{ProveDlog, h}; cost includes
 *     arm envelope (10) + Const child (5) = 15, plus whatever the tree
 *     header adds as ctx already has 0.
 *   - identity-point: 33-zero-byte identity EcPoint → same shape.
 *   - cost-limit-exceeded: tight jitCostLimit triggers 'cost-limit-exceeded'.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, captureEvalError, rehydrateEvalOpts } from '../_helpers'

interface CreateProveDlogEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown | null
  expected_cost: number
  expected_error_code: string | null
}

interface CreateProveDlogFixture {
  description: string
  entries: CreateProveDlogEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/create-prove-dlog.json')
const fixture: CreateProveDlogFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('CreateProveDlog eval arm', () => {
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
