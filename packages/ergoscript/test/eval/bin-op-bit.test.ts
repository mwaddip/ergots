/**
 * BinOp.Bit family — fixture-driven evaluation tests.
 *
 * The fixture (fixture-gen, frozen) records sigma-rust's behaviour: BitAnd, BitOr and BitXor evaluate to a
 * value at a cost of 11 (Fixed(1) envelope + 5 per Const operand, bin_op.rs:215-217), and the three shift ops
 * return EvalError::Misc("no interpreter eval"). The JVM 6.0.6 gives a raw BitOp of all six ops no eval
 * (trees.scala:911-917; the default `Value.eval` throws, values.scala:101-102), so a spend that evaluates
 * one is rejected. ergots followed sigma-rust until 2026-09-30 and now rejects every one of these trees with
 * 'unsupported-eval-node', charging nothing (docs/specs/2026-09-30-jvm-node-construction-design.md §9). The
 * fixture JSON is not edited: the recorded values and codes stay in it as sigma-rust's, and this test no
 * longer asserts them.
 *
 * A local sigma-state 6.0.6 probe, spend mode, rejected each entry's node at reduce ("Should be overriden in
 * class sigma.ast.BitOp"): the trees here are bare roots, so the probe ran each node wrapped as
 * `sigmaProp(node == its left operand)` at v0. The probed trees of every operand kind and position, at v0 and
 * v3, are in jvm-no-eval-nodes.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { ExprParseError } from '../../src/wire/errors'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/bin-op-bit.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: any
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

// Entries whose tree the JVM rejects at parse, as ergots does since 2026-09-30 (BitOp's require,
// trees.scala:913; wire/check-build.ts). Their expected_error_code is sigma-rust's, which evaluates
// the tree. A local sigma-state 6.0.6 probe rejects each at parse, with and without checkType:
// SerializerException from IllegalArgumentException.
const PARSE_REJECTS: Record<string, string> = {
  bitand_not_numeric_bool: 'bit-op-operand-not-numeric',
}

describe('BinOp.Bit family — fixture-driven', () => {
  for (const entry of fixture.entries) {
    const atParse = PARSE_REJECTS[entry.name]
    if (atParse !== undefined) {
      it(`${entry.name}: ${atParse} at parse`, () => {
        let err: unknown
        try {
          parseTree(hexToBytes(entry.tree_bytes_hex))
        } catch (e) {
          err = e
        }
        expect(err).toBeInstanceOf(ExprParseError)
        expect((err as ExprParseError).code).toBe(atParse)
      })
      continue
    }
    // Every other entry's root is a raw BitOp, rejected when evaluated (the probe: "Should be overriden"):
    // whatever sigma-rust's recorded value or code, and whatever the operand kinds.
    it(`${entry.name}: unsupported-eval-node (the fixture records sigma-rust's ${entry.expected_error_code ?? 'value + cost'})`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const err = captureEvalError(() => evaluateWith(tree, ctx))
      expect(err.code).toBe('unsupported-eval-node')
      expect(ctx.jitCost).toBe(0)
    })
  }
})
