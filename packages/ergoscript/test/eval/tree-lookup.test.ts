/**
 * TreeLookup arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/tree_lookup.rs:20-65
 *   No add_jit_cost call — children-only cost.
 *   Eval order: tree → key → proof → BatchAVLVerifier::new → perform_one_operation(Lookup).
 *
 *   match opt {
 *     Some(v) => Ok(Value::Opt(Some(Box::new(v.to_vec().into())))),  // Option Some<Coll[Byte]>
 *     None    => Ok(Value::Opt(None)),                                // Option None
 *   }
 *   Err(_) => Err(EvalError::AvlTree(format!("Tree proof is incorrect {:?}", ...)))
 *
 * Critical load-bearing behavior: the DOUBLE-NULL semantic from `@ergots/avltree`'s
 * `verifyAvlLookup` (facts/avltree.md:70-76).
 *
 *   - `result === null`           → proof construct fail / per-op fail / digest
 *                                   mismatch → TS throws 'avl-tree-proof-failed'
 *   - `result.value === null`     → proof verified, key ABSENT → Option None
 *   - `result.value: Uint8Array`  → proof verified, key FOUND → Option Some<Coll[Byte]>
 *
 * The fixture matrix EXPLICITLY distinguishes these:
 *   - `tl_absent_in_10_leaf`         → Option None (inner null, value-side)
 *   - `tl_throw_malformed_proof`     → throws 'avl-tree-proof-failed' (outer null)
 *   - `tl_throw_wrong_digest`        → throws 'avl-tree-proof-failed' (outer null)
 *
 * A handler that confuses inner-null vs outer-null would silently mis-route
 * malformed-proof scenarios to Option None (consensus divergence!) — these
 * fixtures are the canary.
 *
 * Throw paths (non-AvlTree receiver, malformed proof, wrong digest):
 *   - The non-AvlTree receiver case uses a synthesized MIR tree that bypasses
 *     `TreeLookup::new`'s build-time SAvlTree guard (multiply_group / exponentiate
 *     / create_avl_tree throw-entry precedent).
 *   - Malformed-proof and wrong-digest paths use real BatchAVLProver output
 *     plus an explicit byte mutation.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/tree-lookup.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('TreeLookup arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
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
