/**
 * If arm — fixture-driven evaluation tests.
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/if_op.rs:16`.
 *
 * Cost: If = Fixed(10) (envelope) + condition cost + ONLY taken branch's
 * cost. Both fixtures use a Boolean Const condition + two Int Const branches:
 * 10 + 5 + 5 = 20 for both true and false.
 *
 * Short-circuit semantics are verified separately by giving the non-taken
 * branch an out-of-range ConstPlaceholder — if the arm tried to evaluate it,
 * the test would throw on the resolution failure rather than return cleanly.
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
import type { Expr, SValue } from '../../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/if.json')

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

describe('If arm — fixture-driven', () => {
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

describe('If arm — non-Boolean condition', () => {
  it('throws if-condition-not-boolean when condition evaluates to non-Boolean', () => {
    const expr: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
      trueBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
      falseBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } },
    }
    const ctx = makeContext()
    expect(() => evalExpr(expr, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalExpr(expr, Env.empty(), ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('if-condition-not-boolean')
    }
  })
})

describe('If arm — short-circuit', () => {
  it('does NOT evaluate the false branch when condition is true', () => {
    // false branch is a ConstPlaceholder with id=99 (out of range) — would throw if evaluated.
    const expr: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
      trueBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
      falseBranch: { tag: 'ConstPlaceholder', id: 99, tpe: { tag: 'SInt' } },
    }
    const ctx = makeContext({ constants: [] })
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 1 })
  })

  it('does NOT evaluate the true branch when condition is false', () => {
    const expr: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: false } },
      trueBranch: { tag: 'ConstPlaceholder', id: 99, tpe: { tag: 'SInt' } },
      falseBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } },
    }
    const ctx = makeContext({ constants: [] })
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 2 })
  })
})
