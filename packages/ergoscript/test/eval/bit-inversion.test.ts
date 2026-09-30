/**
 * BitInversion arm — fixture-driven evaluation tests.
 *
 * The fixture (fixture-gen, frozen) records sigma-rust's behaviour
 * (ergotree-interpreter/src/eval/bit_inversion.rs:15): a Fixed(1) envelope, the
 * operand, then the bitwise complement masked to the kind's signed range (5 numeric
 * kinds × 3 boundary values, 0, MAX_K and MIN_K = 15 entries, at a cost of 6). The
 * JVM 6.0.6 gives BitInversion no eval (trees.scala:899-903, costKind =
 * Value.notSupportedError at :906; the default `Value.eval` throws,
 * values.scala:101-102), so a spend that evaluates one is rejected. ergots followed
 * sigma-rust until 2026-09-30 and now rejects every one of these trees with
 * 'unsupported-eval-node', charging nothing
 * (docs/specs/2026-09-30-jvm-node-construction-design.md §9). The fixture JSON is
 * not edited: the recorded values stay in it as sigma-rust's, and this test no
 * longer asserts them.
 *
 * A local sigma-state 6.0.6 probe, spend mode, rejected each entry's node at reduce
 * ("Should be overriden in class sigma.ast.BitInversion"): the trees here are bare
 * roots, so the probe ran each node wrapped as `sigmaProp(node == its operand)` at
 * v0. The probed trees of other operand kinds and positions, at v0 and v3, are in
 * jvm-no-eval-nodes.test.ts.
 *
 * A non-numeric input is rejected by `BitInversion::try_build` in sigma-rust at
 * build time (`ergotree-ir/src/mir/bit_inversion.rs:38-50`) and by the JVM's
 * constructor `require` (trees.scala:900), a wire-layer check here
 * (wire/check-build.ts), so the fixture cannot serialize a malformed tree. The
 * arm's reject of a hand-built MIR node with a non-numeric operand is covered by
 * an inline test that calls `evalExpr` directly (LogicalNot precedent).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import type { BitInversion } from '../../src/mir/types'
import { captureEvalError, hexToBytes } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/bit-inversion.json')

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

describe('BitInversion arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    // A raw BitInversion root, rejected when evaluated (the probe: "Should be overriden"): whatever
    // sigma-rust's recorded value, and whatever the operand's kind.
    it(`${entry.name}: unsupported-eval-node (the fixture records sigma-rust's ${entry.expected_error_code ?? 'value + cost'})`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      const err = captureEvalError(() => evaluateWith(tree, ctx))
      expect(err.code).toBe('unsupported-eval-node')
      expect(ctx.jitCost).toBe(0)
    })
  }
})

describe('BitInversion arm — non-numeric operand', () => {
  // The arm no longer reads its operand (the JVM has no eval for the node), so a hand-built node over a
  // Boolean rejects as every BitInversion does, not with 'bin-op-not-numeric'. No tree from bytes holds
  // such a node: the JVM's constructor require (trees.scala:900) rejects it at parse.
  it('rejects with unsupported-eval-node without inspecting a non-numeric operand', () => {
    const expr: BitInversion = {
      tag: 'BitInversion',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('unsupported-eval-node')
    expect(ctx.jitCost).toBe(0)
  })
})
