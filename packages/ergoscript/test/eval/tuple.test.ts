/**
 * Tuple arm — fixture-driven evaluation tests.
 *
 * Each fixture entry serializes an `Expr::Tuple(items)` (no constant
 * segregation — items are inline `Expr::Const`). We assert the evaluator
 * returns a `{ kind: 'Tuple', items: [...] }` SValue and charges:
 *
 *     15 (envelope)  +  sum of item costs  =  total
 *
 * For these fixtures every item is a Const (cost 5), so a 2-tuple is 25
 * and a 3-tuple is 30. Sigma-rust ref:
 *   `ergotree-interpreter/src/eval/tuple.rs:9-19`
 *
 * Long / BigInt items come across as decimal strings in the fixture JSON
 * (no native bigint literal in JSON) and are rehydrated to `bigint` here
 * recursively so the deep-equal comparison succeeds against the SValue
 * union.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { SValue } from '../../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/tuple.json')

interface JsonValue {
  kind: string
  value?: unknown
  items?: JsonValue[]
}

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: JsonValue
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

function hydrateValue(j: JsonValue): SValue {
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) } as SValue
  }
  if (j.kind === 'Tuple') {
    return {
      kind: 'Tuple',
      items: (j.items ?? []).map(hydrateValue),
    } as SValue
  }
  return j as SValue
}

describe('Tuple arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
