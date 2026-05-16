/**
 * Unit tests for _coll-helpers.ts: extractCollItems + extractFuncValue.
 *
 * extractCollItems:
 *   - Returns { items, elem } from a Coll SValue.
 *   - Throws EvalError 'coll-input-not-coll' on non-Coll SValue.
 *
 * extractFuncValue:
 *   - Returns closure from a Lambda SValue with non-empty argIds.
 *   - Throws EvalError 'lambda-not-callable' on non-Lambda SValue.
 *   - Throws EvalError 'lambda-not-callable' on Lambda with empty argIds.
 *
 * Source: _coll-helpers.ts (new module, phase 2f Coll HOFs Task 1)
 * Design: docs/specs/2026-05-16-ergoscript-phase-2f-coll-hofs-design.md §Architecture
 */
import { describe, it, expect } from 'vitest'
import { extractCollItems, extractFuncValue } from '../../src/eval/_coll-helpers'
import type { SValue, Expr } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

// ---------------------------------------------------------------------------
// Test helpers — minimal SValue constructors
// ---------------------------------------------------------------------------

function makeCollSValue(items: SValue[]): SValue {
  return { kind: 'Coll', elem: { tag: 'SInt' }, items }
}

function makeTrueLambdaSValue(argId: number): SValue {
  // A Lambda SValue with one argId and a trivial body (BooleanConstant True)
  const body: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
  return { kind: 'Lambda', closure: { argIds: [argId], body, capturedEnv: {} } }
}

function makeEmptyArgLambdaSValue(): SValue {
  // A Lambda SValue with empty argIds (malformed)
  const body: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
  return { kind: 'Lambda', closure: { argIds: [], body, capturedEnv: {} } }
}

// ---------------------------------------------------------------------------
// extractCollItems
// ---------------------------------------------------------------------------

describe('extractCollItems', () => {
  it('returns items and elem from a Coll SValue', () => {
    const items: SValue[] = [
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
      { kind: 'Int', value: 3 },
    ]
    const coll = makeCollSValue(items)
    const result = extractCollItems(coll)
    expect(result.items).toStrictEqual(items)
    expect(result.elem).toStrictEqual({ tag: 'SInt' })
  })

  it('throws coll-input-not-coll when given a non-Coll SValue', () => {
    const nonColl: SValue = { kind: 'Int', value: 42 }
    const err = captureEvalError(() => extractCollItems(nonColl))
    expect(err.code).toBe('coll-input-not-coll')
  })
})

// ---------------------------------------------------------------------------
// extractFuncValue
// ---------------------------------------------------------------------------

describe('extractFuncValue', () => {
  it('returns closure from a Lambda SValue with non-empty argIds', () => {
    const lambda = makeTrueLambdaSValue(1)
    if (lambda.kind !== 'Lambda') throw new Error('test setup error')
    const closure = extractFuncValue(lambda)
    expect(closure.argIds).toEqual([1])
    expect(closure.argIds.length).toBe(1)
  })

  it('throws lambda-not-callable on non-Lambda SValue', () => {
    const nonLambda: SValue = { kind: 'Boolean', value: true }
    const err = captureEvalError(() => extractFuncValue(nonLambda))
    expect(err.code).toBe('lambda-not-callable')
  })

  it('throws lambda-not-callable on Lambda with empty argIds', () => {
    const emptyArgsLambda = makeEmptyArgLambdaSValue()
    const err = captureEvalError(() => extractFuncValue(emptyArgsLambda))
    expect(err.code).toBe('lambda-not-callable')
  })
})
