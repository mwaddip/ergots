/**
 * SHeader property accessor handlers (typeId 104, methodIds 1-15) — Phase 2h-c.1.
 *
 * Two test suites:
 *   1. Oracle fixture-driven: 15 entries from eval/sheader-handlers.json, one per handler.
 *      Each entry evaluates the tree PropertyCall(ByIndex(PropertyCall(Context, headers), 0), method)
 *      and asserts value + cost match sigma-rust's oracle output.
 *   2. Defensive obj-kind check: 3 parameterized tests confirming each handler throws
 *      'header-obj-not-header' when the receiver is not a Header SValue.
 *
 * Source: ergotree-interpreter/src/eval/sheader.rs:16-113
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'
import {
  evalSHeaderId,
  evalSHeaderHeight,
  evalSHeaderMinerPk,
} from '../../src/eval/sheader'
import type { SValue } from '../../src/mir/types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sheader-handlers.json')

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

const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, 'utf-8'))

// ---------- Oracle fixture-driven tests ----------

describe('SHeader handlers — oracle fixture-driven (Phase 2h-c.1)', () => {
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

// ---------- Defensive obj-kind check ----------

describe('SHeader.* defensive obj-kind check', () => {
  // Direct handler call with a non-Header obj — each should throw 'header-obj-not-header'.
  const longVal: SValue = { kind: 'Long', value: 42n }
  const emptyCtx = makeContext({})

  it('evalSHeaderId (104:1) throws header-obj-not-header on non-Header obj', () => {
    const err = captureEvalError(() => evalSHeaderId(longVal, [], emptyCtx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('header-obj-not-header')
  })

  it('evalSHeaderHeight (104:9) throws header-obj-not-header on non-Header obj', () => {
    const err = captureEvalError(() => evalSHeaderHeight(longVal, [], emptyCtx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('header-obj-not-header')
  })

  it('evalSHeaderMinerPk (104:11) throws header-obj-not-header on non-Header obj', () => {
    const err = captureEvalError(() => evalSHeaderMinerPk(longVal, [], emptyCtx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('header-obj-not-header')
  })
})
