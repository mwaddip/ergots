/**
 * SAvlTree.insertOrUpdate (100:16) — V3-gated batch-InsertOrUpdate handler.
 *
 * Fixture-driven oracle suite (T11 of phase 2h-d). Handler implementation
 * lives at `src/eval/savltree.ts` (appended in T11 GREEN); six-scenario
 * fixture emitted by T10.
 *
 * Scenario coverage:
 *   1. insert_or_update_happy_v3                — happy path; full-success batch returns Some(AvlTree(new_digest)).
 *   2. insert_or_update_insert_allowed_false    — receiver's INSERT_ALLOWED bit clear → Option None pre-verify.
 *   3. insert_or_update_update_allowed_false    — receiver's UPDATE_ALLOWED bit clear → Option None pre-verify.
 *   4. insert_or_update_per_op_fail_graceful    — per-op fail under V3+ → graceful Option None (sigma-rust break).
 *   5. insert_or_update_malformed_proof         — verifier construct fail → throws 'avl-tree-proof-failed'.
 *   6. insert_or_update_v2_dispatcher_reject    — opts_json.treeVersion=2 → dispatcher rejects with 'tree-version-too-low'.
 *
 * Test uses the canonical multi-scenario template from
 * `test/eval/savltree-update-digest.test.ts:58-74`. Each entry branches on
 * `expected_error_code !== null`:
 *   - Throw branch: `captureEvalError` + `expect(err.code).toBe(...)`.
 *     Cost is NOT asserted on throw entries (fixture-gen sentinels
 *     `expected_cost: 0`).
 *   - Success branch: assert value matches hydrated SValue + cost matches
 *     fixture-recorded `ctx.jitCost`.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:441-498 — INSERT_OR_UPDATE_EVAL_FN.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface InsertOrUpdateEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json?: unknown
  expected_cost: number
  expected_error_code?: string | null
}
interface InsertOrUpdateFixture {
  corpus: string
  entries: InsertOrUpdateEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-insert-or-update.json')
const fixture: InsertOrUpdateFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.insertOrUpdate (100:16) — V3-gated, fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      if (entry.expected_error_code) {
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
