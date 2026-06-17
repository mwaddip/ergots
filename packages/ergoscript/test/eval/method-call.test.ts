/**
 * Layer C1 — `MethodCall` + `PropertyCall` dispatcher + SBox.tokens + SContext.dataInputs
 * + SColl.indexOf handlers.
 *
 * Task 3: dispatcher + registry with ZERO registered handlers (cost + unknown-pair throw).
 * Task 4: SBox.tokens handler (typeId=99, methodId=8) — fixture-driven C1 tests.
 * Task 5: SContext.dataInputs handler (typeId=101, methodId=1) — fixture-driven C1 tests.
 * Task 6: SColl.indexOf handler (typeId=12, methodId=26) — defensive-throw unit tests.
 *
 * Source: ergotree-interpreter/src/eval/{method_call,property_call,sbox,scontext,scoll}.rs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { evalMethodCall, evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import type { MethodCall, PropertyCall } from '../../src/mir/types'
import { hexToBytes, hydrateSValue, synthesizeStubBox, captureEvalError, parseParsedTree as parseTree } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface MethodCallFixtureEntry {
  name: string
  tree_bytes_hex: string
  ctx?: {
    self_box_tokens?: Array<{ id: string; amount: string }>
    data_inputs_count?: number
  }
  expected_value_json: unknown
  expected_cost: number
}

interface MethodCallFixtureFile {
  description: string
  entries: MethodCallFixtureEntry[]
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/eval/method-call.json'), 'utf8')
) as MethodCallFixtureFile

describe('MethodCall dispatcher — skeleton (no handlers registered)', () => {
  it("charges cost 4 and throws 'method-not-implemented' on unknown pair", () => {
    // PropertyCall with obj = Context, but typeId=255/methodId=255 is unregistered.
    const e: PropertyCall = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      typeId: 255,
      methodId: 255,
      obj: { tag: 'Context' },
    }
    // Use a fresh ctx for each invocation so cost assertions are unambiguous.
    const ctx1 = makeContext({})
    expect(() => evalPropertyCall(e, Env.empty(), ctx1)).toThrow(EvalError)
    // Cost charging: 4 (dispatcher) + 1 (Context arm) = 5 per call.
    expect(ctx1.jitCost).toBeGreaterThanOrEqual(5)

    const ctx2 = makeContext({})
    try {
      evalPropertyCall(e, Env.empty(), ctx2)
    } catch (err) {
      expect((err as EvalError).code).toBe('method-not-implemented')
      expect((err as EvalError).message).toContain('typeId=255')
      expect((err as EvalError).message).toContain('methodId=255')
    }
    expect(ctx2.jitCost).toBeGreaterThanOrEqual(5)
  })

  it("MethodCall variant charges cost 4 and throws 'method-not-implemented' on unknown pair", () => {
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 255,
      methodId: 255,
      obj: { tag: 'Context' },
      args: [],
      explicitTypeArgs: {},
    }
    const ctx1 = makeContext({})
    expect(() => evalMethodCall(e, Env.empty(), ctx1)).toThrow(EvalError)
    expect(ctx1.jitCost).toBeGreaterThanOrEqual(5)

    const ctx2 = makeContext({})
    try {
      evalMethodCall(e, Env.empty(), ctx2)
    } catch (err) {
      expect((err as EvalError).code).toBe('method-not-implemented')
      expect((err as EvalError).message).toContain('typeId=255')
      expect((err as EvalError).message).toContain('methodId=255')
    }
    expect(ctx2.jitCost).toBeGreaterThanOrEqual(5)
  })
})

describe('registered method handler defensive throws', () => {
  it("SBox.tokens throws 'method-not-implemented' when obj is not Box", () => {
    // typeId=99, methodId=8 is the SBox.tokens handler.
    // Passing a Context obj produces { kind: 'Context' } from evalExpr, which
    // is not 'Box' — triggers the defensive shape-guard throw.
    const e: PropertyCall = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      typeId: 99,
      methodId: 8,
      obj: { tag: 'Context' },
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
    expect(err.message).toContain('Box')
  })

  it("SContext.dataInputs throws 'context-obj-not-context' when obj is not Context", () => {
    // typeId=101, methodId=1 is the SContext.dataInputs handler.
    // Passing GlobalVars.SelfBox produces { kind: 'Box', value: ... } from evalExpr,
    // which is not 'Context' — triggers the defensive shape-guard throw.
    const e: PropertyCall = {
      tag: 'PropertyCall',
      explicitTypeArgs: {},
      typeId: 101,
      methodId: 1,
      obj: { tag: 'GlobalVars', kind: 'SelfBox' },
    }
    const stubBox = synthesizeStubBox()
    const ctx = makeContext({ selfBox: stubBox })
    const err = captureEvalError(() => evalPropertyCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-obj-not-context')
    expect(err.message).toContain('Context')
  })

  it("SColl.indexOf throws 'method-not-implemented' when obj is not Coll", () => {
    // typeId=12, methodId=26 is the SColl.indexOf handler.
    // Passing a Long Const produces { kind: 'Long' } from evalExpr, which is
    // not 'Coll' — triggers the first defensive shape-guard throw.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 12,
      methodId: 26,
      obj: { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 42n } },
      args: [
        { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 1n } },
        { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
    expect(err.message).toContain('Coll')
  })

  it("SColl.indexOf throws 'method-not-implemented' when args.length !== 2", () => {
    // Only 1 arg supplied — the handler checks args.length after extracting the Coll.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 12,
      methodId: 26,
      obj: {
        tag: 'Collection',
        kind: 'Exprs',
        elemTpe: { tag: 'SLong' },
        items: [],
      },
      args: [
        { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 1n } },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
  })

  it("SColl.indexOf throws 'method-not-implemented' when fromArg is not Int", () => {
    // args[1] is Long, not Int — the handler checks fromArg.kind after extracting both args.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 12,
      methodId: 26,
      obj: {
        tag: 'Collection',
        kind: 'Exprs',
        elemTpe: { tag: 'SLong' },
        items: [],
      },
      args: [
        { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 1n } },
        { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 0n } }, // Long, not Int
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
  })
})

describe('method-call fixture entries (Tasks 4-6: SBox.tokens + SContext.dataInputs + SColl.indexOf)', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const stubBox = synthesizeStubBox({
        tokens: (entry.ctx?.self_box_tokens ?? []).map((t) => ({
          id: hexToBytes(t.id),
          amount: BigInt(t.amount),
        })),
      })
      const dataInputsCount = entry.ctx?.data_inputs_count ?? 0
      const dataInputs = Array.from({ length: dataInputsCount }, () => synthesizeStubBox({}))
      const ctx = makeContext({
        constants: tree.constants,
        selfBox: stubBox,
        inputs: [stubBox],
        outputs: [stubBox],
        dataInputs,
      })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
