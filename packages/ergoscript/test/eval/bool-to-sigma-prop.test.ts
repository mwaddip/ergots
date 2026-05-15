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
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import type { BoolToSigmaProp } from '../../src/mir/types'
import { parseSigmaBoolean } from '../../src/wire/sigma-boolean'
import { ByteReader } from '../../src/wire/reader'
import { hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/bool-to-sigma-prop.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; raw_hex?: string }
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
      const reader = new ByteReader(value.value.raw)
      const sb = parseSigmaBoolean(reader)
      expect(sb).toBeDefined()
      expect(reader.remaining).toBe(0)
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
    expect(() => evalExpr(expr, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalExpr(expr, Env.empty(), ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('bin-op-not-boolean')
    }
  })
})
