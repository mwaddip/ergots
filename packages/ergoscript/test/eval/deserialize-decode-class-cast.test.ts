// A script decoded at spend whose own construction throws (spec
// docs/specs/2026-09-30-jvm-node-construction-design.md §5 item 2, the decode). The JVM decodes a
// DeserializeContext or DeserializeRegister script with ValueSerializer.deserialize inside
// substDeserialize (Interpreter.scala:79-87, 110-129; ErgoLikeInterpreter.scala:17-37), under Kiama's
// strategy, which swallows a ClassCastException and leaves the node in place
// (core/.../sigma/kiama/rewriting/Rewriter.scala:180-191). So a dead node accepts and a live one
// rejects when it is evaluated. Any other decode failure propagates: the spend rejects, dead or live.
//
// The script If(true, 0, OptionGet(ByIndex(tuple))) is a class cast: OptionGet casts the JVM's SAny to
// SOption as it is built (transformers.scala:600-601). The control If(true, 0, Negation(true)) is not:
// Negation's require fails (trees.scala:882, an IllegalArgumentException). Every verdict is a local
// sigma-state 6.0.6 probe's (spend mode: the tree as SELF, R4 and variable 1 as given).
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { evaluate } from '../../src/eval/evaluate'
import type { EvalOpts } from '../../src/eval/eval-context'
import { parseExpr } from '../../src/wire/parse'
import { isJvmClassCast } from '../../src/wire/jvm-exceptions'
import type { SType, SValue } from '../../src/mir/types'
import { captureEvalError, parseParsedTree, synthesizeStubBox } from '../_helpers'
import { BI, DC, DR, EQ, If, Negation, OptionGet, T, bool, dead, exprBytes, hex, int, sp, treeBytes } from '../_helpers/mir-build'

const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
const CAST = exprBytes(If(bool(true), int(0), OptionGet(BI)))
const REQUIRE = exprBytes(If(bool(true), int(0), Negation(bool(true))))

/** A Coll[Byte] register or context-variable value holding `b`. */
const collByte = (b: Uint8Array): { tpe: SType; value: SValue } => ({
  tpe: T.Coll(T.Byte),
  value: { kind: 'Coll', elem: T.Byte, items: Array.from(b, (x) => ({ kind: 'Byte', value: (x << 24) >> 24 })) } as SValue,
})
const inR4 = (b: Uint8Array): EvalOpts => ({ selfBox: { ...synthesizeStubBox(), registers: { 4: collByte(b) } } })
const inVar1 = (b: Uint8Array): EvalOpts => ({ extension: { values: new Map([[1, collByte(b)]]) } })

const DR_DEAD = treeBytes(dead(EQ(DR(4, T.Int), int(0))), 0x00)
const DR_LIVE = treeBytes(sp(EQ(DR(4, T.Int), int(0))), 0x00)
const DC_DEAD = treeBytes(dead(EQ(DC(1, T.Int), int(0))), 0x00)
const DC_LIVE = treeBytes(sp(EQ(DC(1, T.Int), int(0))), 0x00)

describe('the probed bytes', () => {
  it('the scripts and the trees are the bytes the probe was given', () => {
    expect(hex(CAST)).toBe('9501010400e4b2860204000400040000')
    expect(hex(REQUIRE)).toBe('9501010400f00101')
    expect(hex(DR_DEAD)).toBe('00d195010093d504040004000101')
    expect(hex(DR_LIVE)).toBe('00d193d50404000400')
    expect(hex(DC_DEAD)).toBe('00d195010093d4040104000101')
    expect(hex(DC_LIVE)).toBe('00d193d404010400')
  })
})

describe('a class cast while a script is decoded leaves the node in place', () => {
  it('T3-swallow-script-decode: the decode fails with a class cast (the JVM: ClassCastException)', () => {
    let err: unknown
    try {
      parseExpr(new ByteReader(CAST), [], [], new Map(), 0)
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'option-get-input-class-cast' })
    expect(isJvmClassCast(err)).toBe(true)
  })
  it('T3-swallow-DR-dead: a dead DeserializeRegister accepts (the JVM: TrueProp)', () => {
    expect(evaluate(parseParsedTree(DR_DEAD), inR4(CAST))).toEqual(TRUE_PROP)
  })
  it('T3-swallow-DR-live: a live one rejects when it is evaluated (the JVM: "Should be overriden", the node unsubstituted)', () => {
    const err = captureEvalError(() => evaluate(parseParsedTree(DR_LIVE), inR4(CAST)))
    expect(err.code).toBe('deserialize-not-substituted')
  })
  it('T3-swallow-DC-dead: a dead DeserializeContext accepts (the JVM: TrueProp)', () => {
    expect(evaluate(parseParsedTree(DC_DEAD), inVar1(CAST))).toEqual(TRUE_PROP)
  })
  it('T3-swallow-DC-live: a live one rejects when it is evaluated (the JVM: "Should be overriden", the node unsubstituted)', () => {
    const err = captureEvalError(() => evaluate(parseParsedTree(DC_LIVE), inVar1(CAST)))
    expect(err.code).toBe('deserialize-not-substituted')
  })
})

describe('any other decode failure rejects the spend, dead or live', () => {
  it('T3-swallow-control-script-decode: the decode fails, not with a class cast (the JVM: IllegalArgumentException)', () => {
    let err: unknown
    try {
      parseExpr(new ByteReader(REQUIRE), [], [], new Map(), 0)
    } catch (e) {
      err = e
    }
    expect(err).toMatchObject({ code: 'negation-input-not-numeric' })
    expect(isJvmClassCast(err)).toBe(false)
  })
  it('T3-swallow-control-DR-dead: a dead DeserializeRegister rejects (the JVM: IllegalArgumentException)', () => {
    const err = captureEvalError(() => evaluate(parseParsedTree(DR_DEAD), inR4(REQUIRE)))
    expect(err.code).toBe('deserialize-parse-failed')
  })
  it('T3-swallow-control-DC-dead: a dead DeserializeContext rejects (the JVM: IllegalArgumentException)', () => {
    const err = captureEvalError(() => evaluate(parseParsedTree(DC_DEAD), inVar1(REQUIRE)))
    expect(err.code).toBe('deserialize-parse-failed')
  })
})
