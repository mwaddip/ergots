/**
 * BlockValue arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/block.rs:13-65`.
 *
 * Cost: addPerItemCost(1, 1, 10, items.length) envelope + per ValDef
 * (rhs eval cost + 5 ADD_TO_ENV_COST) + result eval cost.
 *
 * Strictness: every BlockValue.items entry must be a ValDef. Encountering
 * any other Expr tag throws `block-item-not-val-def` (mirroring sigma-rust's
 * `try_extract_into::<Spanned<ValDef>>` failure).
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
import type { BlockValue, Expr, SValue } from '../../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/block-value.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: { kind: string; value?: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hydrate(j: { kind: string; value?: unknown }): SValue {
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) } as SValue
  }
  return j as SValue
}

describe('BlockValue arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrate(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('BlockValue arm — strictness', () => {
  it('throws block-item-not-val-def when items contains a non-ValDef', () => {
    const block: BlockValue = {
      tag: 'BlockValue',
      items: [
        { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } } as Expr,
      ],
      result: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
    }
    const ctx = makeContext()
    expect(() => evalExpr(block, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalExpr(block, Env.empty(), ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('block-item-not-val-def')
    }
  })
})
