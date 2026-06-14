/**
 * CreateAvlTree arm — unconditional eval-reject pins (F4 epilogue).
 *
 * The JVM has NO eval override for CreateAvlTree (trees.scala:79-91):
 * `costKind = Value.notSupportedError` + default `Value.eval` →
 * `sys.error("Should be overriden in ...")` (values.scala:102); the node
 * carries a `// TODO v6.0: implement eval` comment (trees.scala:77, issue
 * #907). EVERY evaluation throws JVM-side. JVM-blessed vector pins the
 * reject at ergoTree v3 (`AvlTree.unsupported_eval_nodes_v6.json
 * #create_avl_tree-errored#1`, blessed_by jvm:sigma-state-6.0.3); no v5
 * vector exists because the tree is JVM-unserializable at v5 (the
 * Option-typed constant needs v6 Option data serialization — SANTA reply).
 *
 * ergots' previous arm was a sigma-rust port (constructed AvlTreeData with
 * flag canonicalization + u32 bit-casts) — a consensus over-accept vs the
 * JVM, convergent with sigma-rust/eni (routed to sigma-rust via SANTA).
 * The arm now throws `'unsupported-eval-node'` before charging anything or
 * evaluating any operand.
 *
 * The same epilogue round fixed the node's WIRE layout: the JVM serializes
 * FOUR expr operands (valueLengthOpt is an SOption[SInt]-TYPED expr, no
 * presence tag — CreateAvlTreeSerializer.scala:24-37); sigma-rust's
 * presence-tag `Option<Box<Expr>>` shape is a wire fork. The old fixture
 * corpus (sigma-rust-shaped bytes + evaluating expectations) is therefore
 * retired wholesale; the new entries are JVM-layout trees:
 *
 *   - cat_reject_blessed_vector_v3 — the blessed vector's exact tree bytes
 *     (segregated v3, placeholders, Const(SOption[SInt], None) operand).
 *   - cat_reject_before_operand_eval_garbage_flags_type — same tree with
 *     the flags constant's type flipped SByte→SInt: operand types are
 *     never inspected (the throw precedes operand evaluation).
 *   - cat_reject_inline_operands_vlen_some — inline-constant encoding with
 *     valueLengthOpt = Const(SOption[SInt], Some(32)).
 *
 * Parse/serialize round-trips for the new layout are pinned separately in
 * test/wire/avl.test.ts.
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
const fixturePath = path.join(__dirname, '../fixtures/eval/create-avl-tree.json')

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

describe('CreateAvlTree arm — fixture-driven', () => {
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
