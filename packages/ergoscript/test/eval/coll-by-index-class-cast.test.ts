/**
 * `ByIndex` with a default of another class on a specialised receiver: the
 * JVM calls `getOrElse(index, default)`, which unboxes the default through
 * `BoxesRunTime.unboxTo<T>` at the call, so the receiver's primitive class
 * decides the verdict (`CollsOverArrays.scala:26` at 6.0.7).
 *
 *   - Below tree v3 the default is always evaluated and handed to
 *     `getOrElse` (`transformers.scala:271-276`), so a specialised byte
 *     receiver with a Boolean default throws IN range and out.
 *   - From v3 `apply` is called in range (default untouched; no throw) and
 *     `getOrElse` is called out of range (`:261-270`), so a specialised byte
 *     receiver with a Boolean default throws out of range only.
 *
 * Both throws surface as `EvalError('coll-class-cast')` through the facade.
 * The same scripts are pinned in SANTA under
 * `ByIndex.default_specialisation.json` (12 entries); this file carries the
 * API-built twin so the arm's reach is exercised beside the SANTA vectors.
 */

import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { fromArray } from '../../src/coll'
import type { ByIndex, Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SBOOLEAN: SType = { tag: 'SBoolean' }

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })

function byIndexNode(input: SValue, idx: number, defaultVal: SValue | null, defaultTpe: SType): ByIndex {
  const inputExpr: Expr = {
    tag: 'Const',
    tpe: { tag: 'SColl', elem: (input as { elem: SType }).elem },
    value: input,
  }
  return {
    tag: 'ByIndex',
    input: inputExpr,
    index: { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: idx } },
    default: defaultVal === null
      ? null
      : { tag: 'Const', tpe: defaultTpe, value: defaultVal },
  }
}

describe("ByIndex with a default of another class on a specialised receiver — EvalError('coll-class-cast')", () => {
  const specBytes = fromArray(SBYTE, [byte(1), byte(2)], true)

  it('tree v0, specialised byte receiver, Boolean default, in range: throws', () => {
    const node = byIndexNode(
      specBytes,
      0,
      { kind: 'Boolean', value: true },
      SBOOLEAN,
    )
    const err = captureEvalError(() => evalExpr(node, Env.empty(), makeContext({ treeVersion: 0 })))
    expect(err.code).toBe('coll-class-cast')
  })

  it('tree v0, specialised byte receiver, Boolean default, out of range: throws', () => {
    const node = byIndexNode(
      specBytes,
      9,
      { kind: 'Boolean', value: true },
      SBOOLEAN,
    )
    const err = captureEvalError(() => evalExpr(node, Env.empty(), makeContext({ treeVersion: 0 })))
    expect(err.code).toBe('coll-class-cast')
  })

  it('tree v3, specialised byte receiver, Boolean default, in range: returns the item, default untouched', () => {
    const node = byIndexNode(
      specBytes,
      0,
      { kind: 'Boolean', value: true },
      SBOOLEAN,
    )
    const result = evalExpr(node, Env.empty(), makeContext({ treeVersion: 3 }))
    expect(result).toEqual(byte(1))
  })

  it('tree v3, specialised byte receiver, Boolean default, out of range: throws', () => {
    const node = byIndexNode(
      specBytes,
      9,
      { kind: 'Boolean', value: true },
      SBOOLEAN,
    )
    const err = captureEvalError(() => evalExpr(node, Env.empty(), makeContext({ treeVersion: 3 })))
    expect(err.code).toBe('coll-class-cast')
  })

  it('tree v0, specialised byte receiver, Byte default: control, returns the item', () => {
    const node = byIndexNode(
      specBytes,
      0,
      byte(7),
      SBYTE,
    )
    const result = evalExpr(node, Env.empty(), makeContext({ treeVersion: 0 }))
    expect(result).toEqual(byte(1))
  })

  it('tree v0, plain byte receiver, Boolean default, in range: returns the item (plain rule)', () => {
    const plainBytes = fromArray(SBYTE, [byte(1), byte(2)], false)
    const node = byIndexNode(
      plainBytes,
      0,
      { kind: 'Boolean', value: true },
      SBOOLEAN,
    )
    const result = evalExpr(node, Env.empty(), makeContext({ treeVersion: 0 }))
    expect(result).toEqual(byte(1))
  })

  it('tree v0, plain byte receiver, Boolean default, out of range: returns the Boolean default (plain rule)', () => {
    const plainBytes = fromArray(SBYTE, [byte(1), byte(2)], false)
    const node = byIndexNode(
      plainBytes,
      9,
      { kind: 'Boolean', value: true },
      SBOOLEAN,
    )
    const result = evalExpr(node, Env.empty(), makeContext({ treeVersion: 0 }))
    expect(result).toEqual({ kind: 'Boolean', value: true })
  })
})
