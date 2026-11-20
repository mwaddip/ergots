/**
 * XorOf arm — the exclusive or of a collection of Booleans, at every tree version.
 *
 * JVM (sigma-state 6.0.7): `XorOf.eval` (data/shared/src/main/scala/sigma/ast/trees.scala:238-245) charges
 * `PerItemCost(20, 5, 32)` (:253-254) by the collection's length, then calls `xorOf`
 * (data/shared/src/main/scala/sigma/data/CSigmaDslBuilder.scala:116-127): `false` for no item, the item for one,
 * the exclusive or of all of them otherwise. Every item is read.
 *
 * The fixture rows give a value and a cost per tree; the rows named by a SANTA row are JVM-blessed
 * (`vectors/eval/{v5,v6}/authored/` at commit 0f2fc79).
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
import type { XorOf } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/xor-of.json')

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

describe('XorOf arm — fixture-driven', () => {
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

/** [row, SANTA file, tree bytes, tree version, the value answered, the cost] */
const BLESSED: [string, string, string, number, boolean, number][] = [
  ['xorof-t-separating-t0#6', 'v5/authored/XorOf.activated_version_gate.json', '00ff0d0101', 0, true, 30],
  ['xorof-ttf-separating-t0#3', 'v5/authored/XorOf.activated_version_gate.json', '00ff0d0303', 0, false, 30],
  ['xorof-ttt-separating-t0#4', 'v5/authored/XorOf.activated_version_gate.json', '00ff0d0307', 0, true, 30],
  ['xorof-tft-separating-t1#9', 'v5/authored/XorOf.activated_version_gate.json', '0904ff0d0305', 1, false, 30],
  ['XorOf-const-L33-none-v0-a2#22', 'v5/authored/XorOf.item_by_item.json', '00ff0d21ffffffff01', 0, true, 35],
  // A tuple of three Booleans, (false, true, true).
  ['XorOf-tuple-L3-k0-v0-a2#9', 'v5/authored/XorOf.item_by_item.json', '00ff48010101000101', 0, false, 30],
  ['XorOf-tuple-L3-k0-v3-a3#19', 'v6/authored/XorOf.item_by_item_v6.json', '0b08ff48010101000101', 3, false, 30],
  ['XorOf-const-L0-none-v0-a2#0', 'v5/authored/XorOf.item_by_item.json', '00ff0d00', 0, false, 30],
]

describe('XorOf is the exclusive or at every tree version (JVM-blessed rows)', () => {
  for (const [row, file, treeHex, treeVersion, value, cost] of BLESSED) {
    it(`${row} (${file}): ${value} at ${cost}`, () => {
      const tree = parseTree(hexToBytes(treeHex))
      const ctx = makeContext({ treeVersion })
      expect(evaluateWith(tree, ctx)).toEqual({ kind: 'Boolean', value })
      expect(ctx.jitCost).toBe(cost)
    })
  }

  it("XorOf-direct-dKn-Int5-v0-a2#110 (v5/authored/XorOf.item_by_item.json): (false, 5, true) is 'coll-not-boolean'", () => {
    const tree = parseTree(hexToBytes('00ff48010401000a01'))
    const err = captureEvalError(() => evaluateWith(tree, makeContext({ treeVersion: 0 })))
    expect(err.code).toBe('coll-not-boolean')
  })
})

describe('XorOf arm — defensive', () => {
  it('throws coll-not-boolean when input is not a Coll', () => {
    const expr: XorOf = {
      tag: 'XorOf',
      input: {
        tag: 'Const',
        tpe: { tag: 'SBoolean' },
        value: { kind: 'Boolean', value: true },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-not-boolean')
  })

  it('throws coll-not-boolean when Coll items are not Boolean', () => {
    const expr: XorOf = {
      tag: 'XorOf',
      input: {
        tag: 'Const',
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
        value: {
          kind: 'Coll',
          elem: { tag: 'SInt' },
          items: [
            { kind: 'Int', value: 1 },
            { kind: 'Int', value: 2 },
          ],
        },
      },
    }
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('coll-not-boolean')
  })
})
