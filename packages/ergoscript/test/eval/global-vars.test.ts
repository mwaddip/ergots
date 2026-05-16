/**
 * GlobalVars arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/global_vars.rs:12-50
 *   Pattern A (cost BEFORE; GlobalVars is a leaf).
 *   6 cases: Height(26), SelfBox(10), Outputs(10), Inputs(10),
 *            MinerPubKey(20), GroupGenerator(10).
 *
 * MinerPubKey returns `Coll[Byte]` (33-byte compressed minerPk), NOT GroupElement.
 * GroupGenerator returns `GroupElement` from the hardcoded secp256k1 generator.
 *
 * opts_json schema (fixture-gen `global_vars.rs` → TS):
 *   height          → EvalOpts.height (number)
 *   selfBox         → EvalOpts.selfBox (ErgoBox — hydrateErgoBox)
 *   outputs         → EvalOpts.outputs (ErgoBox[])
 *   inputs          → EvalOpts.inputs (ErgoBox[])
 *   preHeader       → EvalOpts.preHeader (PreHeader — rehydratePreHeader)
 *   jitCostLimit    → EvalOpts.jitCostLimit (number)
 *
 * Coverage (7 fixture entries):
 *   - Height happy path → Int(999_999), cost=26
 *   - SelfBox happy path → Box, cost=10
 *   - Outputs happy path → Coll[Box] of [box(50M)], cost=10
 *   - Inputs happy path  → Coll[Box] of [box(20M)], cost=10
 *   - MinerPubKey happy  → Coll[Byte] (33 bytes), cost=20
 *   - GroupGenerator     → GroupElement (secp256k1 G), cost=10
 *   - Height cost-limit  → 'cost-limit-exceeded'
 *
 * Inline defensive tests:
 *   - SelfBox without ctx.selfBox → 'context-field-missing'
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
import type { PreHeader, GlobalVars } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue, hydrateErgoBox } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(
  __dirname,
  '../fixtures/eval/global-vars.json'
)

interface GlobalVarsFixture {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: GlobalVarsFixture[]
}

/**
 * Rehydrate a preHeader JSON object (from fixture-gen) into a runtime
 * `PreHeader` value. Schema:
 *   version: number
 *   parentIdHex: hex → Uint8Array (32 bytes)
 *   timestamp: decimal string → bigint
 *   nBits: number
 *   height: number
 *   minerPkHex: hex → Uint8Array (33 bytes)
 *   votesHex: hex → Uint8Array (3 bytes)
 */
function rehydratePreHeader(json: any): PreHeader {
  return {
    version: json.version as number,
    parentId: hexToBytes(json.parentIdHex as string),
    timestamp: BigInt(json.timestamp as string),
    nBits: json.nBits as number,
    height: json.height as number,
    minerPk: hexToBytes(json.minerPkHex as string),
    votes: hexToBytes(json.votesHex as string),
  }
}

/**
 * Rehydrate opts_json from the fixture into a proper EvalOpts.
 * Each key is optional; only present keys are mapped.
 */
function rehydrateOpts(optsJson: Record<string, unknown>): EvalOpts {
  const opts: EvalOpts = {}
  if (optsJson.jitCostLimit !== undefined) {
    opts.jitCostLimit = optsJson.jitCostLimit as number
  }
  if (optsJson.height !== undefined) {
    opts.height = optsJson.height as number
  }
  if (optsJson.selfBox !== undefined) {
    opts.selfBox = hydrateErgoBox(optsJson.selfBox)
  }
  if (optsJson.outputs !== undefined) {
    opts.outputs = (optsJson.outputs as any[]).map(hydrateErgoBox)
  }
  if (optsJson.inputs !== undefined) {
    opts.inputs = (optsJson.inputs as any[]).map(hydrateErgoBox)
  }
  if (optsJson.preHeader !== undefined) {
    opts.preHeader = rehydratePreHeader(optsJson.preHeader)
  }
  return opts
}

describe('GlobalVars arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const opts = rehydrateOpts(entry.opts_json)
      const ctx = makeContext(opts)

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

describe('GlobalVars arm — context-field-missing guard', () => {
  it("SelfBox without ctx.selfBox throws 'context-field-missing'", () => {
    // Hand-built GlobalVars MIR node to bypass parseTree path.
    const expr: GlobalVars = {
      tag: 'GlobalVars',
      kind: 'SelfBox',
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('context-field-missing')
  })

  it("Inputs without ctx.inputs throws 'context-field-missing'", () => {
    const expr: GlobalVars = {
      tag: 'GlobalVars',
      kind: 'Inputs',
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('context-field-missing')
  })

  it("Outputs without ctx.outputs throws 'context-field-missing'", () => {
    const expr: GlobalVars = {
      tag: 'GlobalVars',
      kind: 'Outputs',
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('context-field-missing')
  })

  it("Height without ctx.height throws 'context-field-missing'", () => {
    const expr: GlobalVars = {
      tag: 'GlobalVars',
      kind: 'Height',
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('context-field-missing')
  })

  it("MinerPubKey without ctx.preHeader throws 'context-field-missing'", () => {
    const expr: GlobalVars = {
      tag: 'GlobalVars',
      kind: 'MinerPubKey',
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('context-field-missing')
  })
})
