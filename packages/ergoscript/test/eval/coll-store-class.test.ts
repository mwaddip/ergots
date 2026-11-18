/**
 * `Append` (node), `SColl.updated` (method 12:20) and `SColl.updateMany`
 * (method 12:21) under the collection module's store rule:
 *   - a specialised receiver refuses an item of another class
 *     (`CollsOverArrays.scala:26`, `:48-57`, `:100-104`) with
 *     `EvalError('coll-class-cast')`;
 *   - a plain reference receiver refuses an item its array's class does
 *     not take with `EvalError('coll-array-store')`;
 *   - an empty `append` receiver returns the operand UNREAD
 *     (`CollsOverArrays.scala:49`), with its own class.
 *
 * The API path (constants constructed through the data reader's class) is
 * exercised here beside the SANTA conformance vectors.
 */

import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { classOf, fromArray } from '../../src/coll'
import type { Append, Expr, MethodCall, SType, SValue } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SGROUP: SType = { tag: 'SGroupElement' }

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const groupElem = (): SValue => ({ kind: 'GroupElement', value: new Uint8Array(33) })

function constOf(tpe: SType, value: SValue): Expr {
  return { tag: 'Const', tpe, value }
}

function sCollOf(elem: SType): SType {
  return { tag: 'SColl', elem }
}

function mcOf(
  typeId: number,
  methodId: number,
  obj: Expr,
  objTpe: SType,
  args: Expr[],
  argTpes: SType[],
  resultTpe: SType,
): MethodCall {
  return {
    tag: 'MethodCall',
    typeId,
    methodId,
    obj,
    args,
    typeSubst: [],
    objTpe,
    argTpes,
    resultTpe,
  } as unknown as MethodCall
}

describe('Append under the module rule', () => {
  it('specialised byte receiver + Coll[Int] operand throws coll-class-cast', () => {
    const recv = fromArray(SBYTE, [byte(1)], true)
    const other = fromArray(SINT, [int(2)], false)
    const expr: Append = {
      tag: 'Append',
      input: constOf(sCollOf(SBYTE), recv),
      col2: constOf(sCollOf(SINT), other),
    }
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), makeContext()))
    expect(err.code).toBe('coll-class-cast')
  })

  it('plain int receiver + Coll[Long] operand throws coll-array-store', () => {
    const recv = fromArray(SINT, [int(1)], false)
    const other = fromArray(SLONG, [long(2n)], false)
    const expr: Append = {
      tag: 'Append',
      input: constOf(sCollOf(SINT), recv),
      col2: constOf(sCollOf(SLONG), other),
    }
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), makeContext()))
    expect(err.code).toBe('coll-array-store')
  })

  it('empty byte receiver + Coll[GroupElement] operand returns the operand with its own class', () => {
    const recv = fromArray(SBYTE, [], false)
    const other = fromArray(SGROUP, [groupElem()], false)
    const expr: Append = {
      tag: 'Append',
      input: constOf(sCollOf(SBYTE), recv),
      col2: constOf(sCollOf(SGROUP), other),
    }
    const result = evalExpr(expr, Env.empty(), makeContext())
    expect(result.kind).toBe('Coll')
    expect(classOf(result as Extract<SValue, { kind: 'Coll' }>)).toEqual({
      shape: 'array',
      specialised: false,
      array: 'GroupElement',
    })
  })

  it('non-empty byte receiver + Coll[Byte] operand keeps the receiver`s class', () => {
    const recv = fromArray(SBYTE, [byte(1)], false)
    const other = fromArray(SBYTE, [byte(2)], false)
    const expr: Append = {
      tag: 'Append',
      input: constOf(sCollOf(SBYTE), recv),
      col2: constOf(sCollOf(SBYTE), other),
    }
    const result = evalExpr(expr, Env.empty(), makeContext())
    expect(classOf(result as Extract<SValue, { kind: 'Coll' }>)).toEqual({
      shape: 'array',
      specialised: false,
      array: 'byte',
    })
  })
})

describe('SColl.updated under the module rule', () => {
  it('specialised byte receiver + Int item throws coll-class-cast', () => {
    const recv = fromArray(SBYTE, [byte(1)], true)
    const expr = mcOf(
      12,
      20,
      constOf(sCollOf(SBYTE), recv),
      sCollOf(SBYTE),
      [constOf(SINT, int(0)), constOf(SINT, int(9))],
      [SINT, SBYTE],
      sCollOf(SBYTE),
    )
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), makeContext()))
    expect(err.code).toBe('coll-class-cast')
  })

  it('plain int receiver + Byte item throws coll-class-cast (unbox)', () => {
    const recv = fromArray(SINT, [int(1)], false)
    const expr = mcOf(
      12,
      20,
      constOf(sCollOf(SINT), recv),
      sCollOf(SINT),
      [constOf(SINT, int(0)), constOf(SBYTE, byte(9))],
      [SINT, SINT],
      sCollOf(SINT),
    )
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), makeContext()))
    expect(err.code).toBe('coll-class-cast')
  })

  it('byte receiver + byte item returns the updated collection', () => {
    const recv = fromArray(SBYTE, [byte(1), byte(2)], false)
    const expr = mcOf(
      12,
      20,
      constOf(sCollOf(SBYTE), recv),
      sCollOf(SBYTE),
      [constOf(SINT, int(1)), constOf(SBYTE, byte(9))],
      [SINT, SBYTE],
      sCollOf(SBYTE),
    )
    const result = evalExpr(expr, Env.empty(), makeContext()) as Extract<SValue, { kind: 'Coll' }>
    expect(result.items).toEqual([byte(1), byte(9)])
    expect(classOf(result)).toEqual({ shape: 'array', specialised: false, array: 'byte' })
  })
})

describe('SColl.updateMany under the module rule', () => {
  it('specialised byte receiver + Int values throws coll-class-cast', () => {
    const recv = fromArray(SBYTE, [byte(1), byte(2)], true)
    const indexes = fromArray(SINT, [int(0)], false)
    const values = fromArray(SINT, [int(9)], false)
    const expr = mcOf(
      12,
      21,
      constOf(sCollOf(SBYTE), recv),
      sCollOf(SBYTE),
      [constOf(sCollOf(SINT), indexes), constOf(sCollOf(SINT), values)],
      [sCollOf(SINT), sCollOf(SBYTE)],
      sCollOf(SBYTE),
    )
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), makeContext()))
    expect(err.code).toBe('coll-class-cast')
  })

  it('byte receiver + byte values returns the updated collection', () => {
    const recv = fromArray(SBYTE, [byte(1), byte(2), byte(3)], false)
    const indexes = fromArray(SINT, [int(0), int(2)], false)
    const values = fromArray(SBYTE, [byte(9), byte(8)], false)
    const expr = mcOf(
      12,
      21,
      constOf(sCollOf(SBYTE), recv),
      sCollOf(SBYTE),
      [constOf(sCollOf(SINT), indexes), constOf(sCollOf(SBYTE), values)],
      [sCollOf(SINT), sCollOf(SBYTE)],
      sCollOf(SBYTE),
    )
    const result = evalExpr(expr, Env.empty(), makeContext()) as Extract<SValue, { kind: 'Coll' }>
    expect(result.items).toEqual([byte(9), byte(2), byte(8)])
    expect(classOf(result)).toEqual({ shape: 'array', specialised: false, array: 'byte' })
  })
})
