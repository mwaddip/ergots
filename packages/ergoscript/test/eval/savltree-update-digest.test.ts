/**
 * SAvlTree.updateDigest (100:15) — Tier-2 mutator op handler.
 *
 * Fixture-driven oracle suite (T7 of phase 2h-d). Handler implementation
 * lives at `src/eval/savltree.ts` (appended in T7 GREEN); two-scenario
 * fixture emitted by T6 (happy + bad-length-throw).
 *
 * Pattern A Fixed(40): `ctx.addCost(40)` runs BEFORE the AvlTree shape
 * check and BEFORE the 33-byte length check, mirroring sigma-rust's
 * `ctx.add_jit_cost(40)?` at savltree.rs:91.
 *
 * Scenario coverage:
 *   1. update_digest_replace_33_byte         — happy path; new 33-byte digest projected into a fresh AvlTreeData.
 *   2. update_digest_bad_length_32_byte      — 32-byte arg → throws 'avl-tree-bad-digest-length'.
 *
 * Test uses the canonical multi-scenario template from
 * `test/eval/coll-exists.test.ts:64-97`. Each entry branches on
 * `expected_error_code !== null`:
 *   - Throw branch: `captureEvalError` + `expect(err.code).toBe(...)`.
 *     Cost is NOT asserted on throw entries (fixture-gen sentinels
 *     `expected_cost: 0`).
 *   - Success branch: assert value matches hydrated SValue + cost matches
 *     fixture-recorded `ctx.jitCost`.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:90-102 — UPDATE_DIGEST_EVAL_FN.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { captureEvalError, hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

interface UpdateDigestEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface UpdateDigestFixture {
  corpus: string
  entries: UpdateDigestEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-update-digest.json')
const fixture: UpdateDigestFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.updateDigest (100:15) — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))

      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
