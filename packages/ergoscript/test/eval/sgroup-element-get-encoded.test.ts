/**
 * Layer C1 — SGroupElement.getEncoded handler (typeId 7, methodId 2). Phase 2h-f.
 *
 * Pattern A cost Fixed(250) (charged BEFORE obj-kind check). Returns the
 * 33-byte SEC1-compressed point as Coll[Byte].
 *
 * Source: ergotree-interpreter/src/eval/sgroup_elem.rs:15-26 — GET_ENCODED_EVAL_FN
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { MethodCall as MethodCallExpr } from '../../src/mir/types'

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sgroup-element-get-encoded.json')
const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SGroupElement.getEncoded — fixture-driven (Layer C1)', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('SGroupElement.getEncoded — edge cases', () => {
  // The throw path is unreachable via the parser (sigma-rust's MethodCall::new
  // type-checks SGroupElement→Coll[Byte] at construction; a non-GroupElement
  // obj would be rejected before fixture-gen ships bytes). Test via a
  // synthesized MethodCall MIR node. Cost-on-throw assertion confirms
  // Pattern A: cost 250 is charged BEFORE the obj-kind check.
  it('charges Fixed(250) before obj-kind check + throws method-not-implemented on non-GroupElement obj', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 0n } },
      typeId: 7,
      methodId: 2,
      args: [],
      explicitTypeArgs: {},
    }
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrow(EvalError)
    // Cost breakdown: 4 (MethodCall envelope) + 5 (Const child) + 250 (handler
    // Pattern A) = 259. Charged BEFORE the obj-kind check throws.
    expect(ctx.jitCost).toBe(259)
  })
})
