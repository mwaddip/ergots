/**
 * TreeLookup arm — unconditional eval-reject pins (F4 epilogue).
 *
 * The JVM has NO eval override for TreeLookup (trees.scala:1322-1338):
 * `costKind = Value.notSupportedError` + default `Value.eval` →
 * `sys.error("Should be overriden in ...")` (values.scala:102). EVERY
 * evaluation throws JVM-side, regardless of operand validity. JVM-blessed
 * vectors pin the reject at BOTH ergoTree v2 and v3
 * (`AvlTree.unsupported_eval_nodes{,_v6}.json`, blessed_by
 * jvm:sigma-state-6.0.3) — see the conformance suites for those.
 *
 * ergots' previous arm was a sigma-rust port (full AVL+ lookup via
 * `@ergots/avltree`) — a consensus over-accept vs the JVM, convergent with
 * sigma-rust/eni (routed to sigma-rust via SANTA). The arm now throws
 * `'unsupported-eval-node'` before charging anything or evaluating any
 * operand.
 *
 * The fixture entries deliberately span the OLD corpus's full shape
 * variety — found / absent / single-leaf / malformed-proof / wrong-digest
 * / non-AvlTree-receiver trees — every one of which must now produce the
 * SAME reject. That pins the reject's unconditionality: no operand shape
 * (valid or garbage) reaches operand evaluation. Parse/serialize for the
 * opcode (0xb7) are pinned separately in test/wire/avl.test.ts.
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
