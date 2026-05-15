/**
 * LogicalNot arm — fixture-driven evaluation tests.
 *
 * Each fixture entry serializes an `Expr::LogicalNot(Expr::Const(b))` tree.
 * We assert the evaluator returns the inverted boolean and charges:
 *
 *     15 (LogicalNot arm envelope)  +  5 (Const input)  =  20 total
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/logical_not.rs:16`
 *   ctx.add_jit_cost(15)?;  // LogicalNot = Fixed(15)
 *
 * Truth table:  !true → false  (cost 20),  !false → true  (cost 20).
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
import type { LogicalNot } from '../../src/mir/types'
import { hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/logical-not.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: EvalOpts
  expected_value_json: { kind: string; value?: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('LogicalNot arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('LogicalNot arm — non-Boolean operand', () => {
  it('throws bin-op-not-boolean when operand is non-Boolean', () => {
    const expr: LogicalNot = {
      tag: 'LogicalNot',
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
