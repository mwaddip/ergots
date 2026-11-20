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
import { serializeSigmaBoolean } from '../../src/wire/sigma-boolean'
import { ByteWriter } from '@ergots/scorex'
import { spendContext } from './_substitution-spends'

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

/**
 * A SigmaProp operand is returned as it is when the block's activated script version is below 2, and is refused
 * from 2 (`BoolToSigmaProp.eval`, data/shared/src/main/scala/sigma/ast/trees.scala:36-51, sigma-state 6.0.7;
 * `isJitActivated` is activated version >= 2, core/shared/src/main/scala/sigma/VersionContext.scala:25). The tree's
 * version is not read.
 *
 * The rows are JVM-blessed (SANTA `vectors/eval/` at commit 0f2fc79), each a `sigmaProp(<the SigmaProp constant
 * ProveDlog(G)>)`:
 *  - `v4/authored/BoolToSigmaProp.activated_version_gate_v4.json` (activated 0 and 1),
 *  - `v5/authored/BoolToSigmaProp.activated_version_gate.json` (activated 2),
 *  - `v6/authored/BoolToSigmaProp.activated_version_gate_v6.json` (activated 3).
 */
describe('BoolToSigmaProp arm — a SigmaProp operand, by the activated script version', () => {
  const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  const TREE_V0 = `00d108cd${G}`
  const TREE_V1 = `0924d108cd${G}`
  const TREE_V3 = `0b24d108cd${G}`

  const sigmaHex = (value: SValue): string => {
    if (value.kind !== 'SigmaProp') throw new Error(`expected a SigmaProp, got ${value.kind}`)
    const w = new ByteWriter()
    serializeSigmaBoolean(value.value, w)
    return Array.from(w.toBytes(), (b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** [row, tree bytes, activated script version] */
  const PASSED_THROUGH: [string, string, number][] = [
    ['booltosigmaprop-sp-const-accept-a0-t0#1', TREE_V0, 0],
    ['booltosigmaprop-sp-const-accept-a1-t0#7', TREE_V0, 1],
    ['booltosigmaprop-sp-const-accept-a1-t1#13', TREE_V1, 1],
  ]
  for (const [row, treeHex, activated] of PASSED_THROUGH) {
    it(`${row}: activated ${activated}, the operand is returned as it is at cost 20`, () => {
      const { tree, ctx } = spendContext({ tree: treeHex }, activated)
      expect(sigmaHex(evaluateWith(tree, ctx))).toBe(`cd${G}`)
      expect(ctx.jitCost).toBe(20)
    })
  }

  /** [row, tree bytes, activated script version] */
  const REFUSED: [string, string, number][] = [
    ['booltosigmaprop-sp-const-reject-t0#1 (activated 2)', TREE_V0, 2],
    ['booltosigmaprop-sp-const-reject-t1#7 (activated 2)', TREE_V1, 2],
    ['booltosigmaprop-sp-const-reject-t0#1 (activated 3)', TREE_V0, 3],
    ['booltosigmaprop-sp-const-reject-t1#7 (activated 3)', TREE_V1, 3],
    // No blessed row: the cast to Boolean at trees.scala:39-40 does not read the tree's version.
    ['a tree of version 3 (activated 3)', TREE_V3, 3],
  ]
  for (const [row, treeHex, activated] of REFUSED) {
    it(`${row}: 'bin-op-not-boolean'`, () => {
      const { tree, ctx } = spendContext({ tree: treeHex }, activated)
      expect(captureEvalError(() => evaluateWith(tree, ctx)).code).toBe('bin-op-not-boolean')
    })
  }

  it('a tree of version 3 at activated 1: the operand is returned as it is (the tree version is not read, trees.scala:39-49)', () => {
    const { ctx } = spendContext({ tree: TREE_V0 }, 1)
    ctx.treeVersion = 3
    const operand: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
    const expr: BoolToSigmaProp = {
      tag: 'BoolToSigmaProp',
      input: { tag: 'Const', tpe: { tag: 'SSigmaProp' }, value: operand },
    }
    expect(evalExpr(expr, Env.empty(), ctx)).toEqual(operand)
  })

  // `sigmaProp(sigmaProp(true))`, the tree `10010101d1d17300` of a mainnet spend at height 680,692 (block version
  // 2, activated script version 1): the outer node's operand is the inner node's SigmaProp.
  const MAINNET_TREE = '10010101d1d17300'

  it('sigmaProp(sigmaProp(true)) at activated 1 is TrivialProp(true)', () => {
    const { tree, ctx } = spendContext({ tree: MAINNET_TREE }, 1)
    expect(evaluateWith(tree, ctx)).toEqual({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } })
  })

  it("sigmaProp(sigmaProp(true)) at activated 2 is 'bin-op-not-boolean'", () => {
    const { tree, ctx } = spendContext({ tree: MAINNET_TREE }, 2)
    expect(captureEvalError(() => evaluateWith(tree, ctx)).code).toBe('bin-op-not-boolean')
  })
})

describe('BoolToSigmaProp arm — a context without a pre-header', () => {
  const trueSigmaProp: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }

  for (const treeVersion of [0, 3] as const) {
    it(`a SigmaProp operand on a tree of version ${treeVersion}: the activated version is asked for and is 'context-field-missing'`, () => {
      const expr: BoolToSigmaProp = {
        tag: 'BoolToSigmaProp',
        input: { tag: 'Const', tpe: { tag: 'SSigmaProp' }, value: trueSigmaProp },
      }
      const err = captureEvalError(() => evalExpr(expr, Env.empty(), makeContext({ treeVersion })))
      expect(err.code).toBe('context-field-missing')
    })
  }

  it('a Boolean operand is TrivialProp of it at cost 20: the activated version is not read', () => {
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
