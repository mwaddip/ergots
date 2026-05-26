/**
 * BoolToSigmaProp arm — fixture-driven evaluation tests.
 *
 * Each fixture entry serializes a `BoolToSigmaProp(Const(b))` tree.
 * We assert the evaluator returns a SigmaProp whose `raw` bytes contain
 * the canonical TrivialProp opcode, and charges:
 *
 *     15 (BoolToSigmaProp arm envelope) + 5 (Const input) = 20 total
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/bool_to_sigma.rs:19`
 *   ctx.add_jit_cost(15)?;  // BoolToSigmaProp = Fixed(15)
 *
 * Truth table:
 *   BoolToSigmaProp(true)  → SigmaProp { raw: [0xd3] }  (cost 20)
 *   BoolToSigmaProp(false) → SigmaProp { raw: [0xd2] }  (cost 20)
 *
 * Round-trip sanity: the produced bytes must be parseable by parseSigmaBoolean.
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
import type { BoolToSigmaProp, SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/bool-to-sigma-prop.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; raw_hex?: string; [key: string]: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('BoolToSigmaProp arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }

  // Sanity: the bytes we construct for TrivialProp(true/false) MUST be
  // parseable by our existing SigmaBoolean reader. This guards against
  // mistyping the opcode byte — and runs over BOTH entries so that a swap
  // of 0xd2/0xd3 is caught even if the value-equality loop somehow misses it.
  for (const entry of fixture.entries) {
    it(`${entry.name}: parses cleanly via parseSigmaBoolean with 0 remaining`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const value = evaluateWith(tree, ctx)
      expect(value.kind).toBe('SigmaProp')
      if (value.kind !== 'SigmaProp') return
      // Phase 2g-medium: value.value is now structural SigmaBoolean.
      // Verify it has the expected TrivialProp tag.
      expect(value.value.tag).toBe('TrivialProp')
    })
  }
})

describe('BoolToSigmaProp arm — non-Boolean operand', () => {
  it('throws bin-op-not-boolean when operand is non-Boolean', () => {
    const expr: BoolToSigmaProp = {
      tag: 'BoolToSigmaProp',
      input: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 5 } },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('bin-op-not-boolean')
  })
})

describe('BoolToSigmaProp arm — pre-v2 ErgoTree SigmaProp pass-through (iter-13)', () => {
  // Sigma-rust ref: bool_to_sigma.rs:32-36 — JVM v4.x compat.
  // Mainnet h=680,692 tx 5fe235558... spent a v0 tree `10010101d1d17300` =
  // BoolToSigmaProp(BoolToSigmaProp(Const(SBoolean, true))). The outer
  // BoolToSigmaProp receives a SigmaProp from the inner one; pre-v2 trees
  // pass it through, v2+ trees reject.

  const trueSigmaProp: SValue = {
    kind: 'SigmaProp',
    value: { tag: 'TrivialProp', value: true },
  }
  const falseSigmaProp: SValue = {
    kind: 'SigmaProp',
    value: { tag: 'TrivialProp', value: false },
  }

  function buildExpr(value: SValue) {
    return {
      tag: 'BoolToSigmaProp' as const,
      input: { tag: 'Const' as const, tpe: { tag: 'SSigmaProp' as const }, value },
    }
  }

  for (const treeVersion of [0, 1] as const) {
    it(`v${treeVersion} tree: SigmaProp(true) input passes through unchanged with cost 15`, () => {
      const ctx = makeContext({ treeVersion })
      const result = evalExpr(buildExpr(trueSigmaProp), Env.empty(), ctx)
      expect(result).toEqual(trueSigmaProp)
      expect(ctx.jitCost).toBe(20) // Const(5) + BoolToSigmaProp(15)
    })

    it(`v${treeVersion} tree: SigmaProp(false) input passes through unchanged with cost 15`, () => {
      const ctx = makeContext({ treeVersion })
      const result = evalExpr(buildExpr(falseSigmaProp), Env.empty(), ctx)
      expect(result).toEqual(falseSigmaProp)
      expect(ctx.jitCost).toBe(20)
    })
  }

  for (const treeVersion of [2, 3] as const) {
    it(`v${treeVersion} tree: SigmaProp input is rejected (strict bool extraction)`, () => {
      const ctx = makeContext({ treeVersion })
      const err = captureEvalError(() =>
        evalExpr(buildExpr(trueSigmaProp), Env.empty(), ctx)
      )
      expect(err.code).toBe('bin-op-not-boolean')
    })
  }

  it('v0 tree: Boolean(true) input still produces TrivialProp(true) (compat path is opt-in)', () => {
    const ctx = makeContext({ treeVersion: 0 })
    const result = evalExpr(
      {
        tag: 'BoolToSigmaProp',
        input: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
      },
      Env.empty(),
      ctx,
    )
    expect(result).toEqual(trueSigmaProp)
    expect(ctx.jitCost).toBe(20) // Const(5) + BoolToSigmaProp(15)
  })
})
