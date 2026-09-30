// The pre-v3 arithmetic type where the evaluator reads it (spec 2026-09-30 §1, Review Focus 2).
// Before tree v3 the JVM's parse upcasts mixed-width arithmetic to the wider operand
// (DeserializationSigmaBuilder.applyUpcast, SigmaBuilder.scala:674-683, 707-712), so the node's type is
// the wider one. The evaluator reads that type in a Map's mapper result (eval/coll-map.ts) and in a
// decoded script's type (eval/_substitute-deserialize.ts), and the values it computes are already the
// wider kind (eval/bin-op/arith.ts). Every verdict below is a local sigma-state 6.0.6 probe's
// (spend mode, the tree as SELF, variable 1 as given).
import { describe, it, expect } from 'vitest'
import { evaluate } from '../../src/eval/evaluate'
import { parseTree } from '../../src/wire/ergo-tree'
import { ExprParseError } from '../../src/wire/errors'
import type { Expr, SValue } from '../../src/mir/types'
import { captureEvalError, parseParsedTree } from '../_helpers'
import { ByIndex, DC, EQ, Plus, T, exprBytes, hex, int, long, sp, treeBytes } from '../_helpers/mir-build'

const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
const collLong = (ns: number[]): Expr => ({
  tag: 'Const',
  tpe: T.Coll(T.Long),
  value: { kind: 'Coll', elem: T.Long, items: ns.map((n) => ({ kind: 'Long', value: BigInt(n) })) },
})
/** Variable 1 holding `bytes` as a Coll[Byte]. */
const var1 = (bytes: Uint8Array) => ({
  values: new Map([[1, {
    tpe: T.Coll(T.Byte),
    value: { kind: 'Coll', elem: T.Byte, items: Array.from(bytes, (x) => ({ kind: 'Byte', value: (x << 24) >> 24 })) } as SValue,
  }]]),
})

describe('a Map whose mapper is x => 1 + x over Coll[Long]', () => {
  // sigmaProp(Coll[Long](5L).map((x: Long) => 1 + x)(0) == 6L): the writer drops a constant's Upcast
  // before v3 (ValueSerializer.scala:157-169), so Plus(Int 1, x) is what an honest v0 tree carries.
  const mapper: Expr = {
    tag: 'FuncValue',
    args: [{ id: 1, tpe: T.Long }],
    body: Plus(int(1), { tag: 'ValUse', valId: 1, tpe: T.Long }),
  }
  const root = sp(EQ(ByIndex({ tag: 'Map', input: collLong([5]), mapper }, int(0)), long(6)))
  it('evaluates at v0: the mapper types as Long, as its values are', () => {
    // The probe: 00d193b2ad11010ad90101059a04027201040000050c, reduced to TrueProp. ergots at 336b3af
    // rejected it: 'lambda-result-type-mismatch' (the mapper typed as Int, its values Long).
    const bytes = treeBytes(root, 0x00)
    expect(hex(bytes)).toBe('00d193b2ad11010ad90101059a04027201040000050c')
    expect(evaluate(parseParsedTree(bytes))).toEqual(TRUE_PROP)
  })
  it('rejects at v3: the mapper types as Int, its left operand', () => {
    // The probe: 0b15d193b2ad11010ad90101059a04027201040000050c, rejected (ConstraintFailed: the
    // EQ's operands are Int and Long). ergots makes that check at parse, as the JVM does.
    const bytes = treeBytes(root, 0x0b)
    expect(hex(bytes)).toBe('0b15d193b2ad11010ad90101059a04027201040000050c')
    let err: unknown
    try {
      parseTree(bytes)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ExprParseError)
    expect((err as ExprParseError).code).toBe('relation-operand-type-mismatch')
  })
})

describe('a DeserializeContext whose script is 1 + 5L', () => {
  // The script is decoded under the spent tree's version (Interpreter.scala:203-238), so before v3
  // its Plus is upcast to Long, and CheckDeserializedScriptType (rule 1000) compares that type.
  const script = exprBytes(Plus(int(1), long(5)))
  it('declared Long, in a v0 tree: substitutes and evaluates', () => {
    // The probe: 00d193d40501050c with variable 1 = 0e059a0402050a, reduced to TrueProp. ergots at
    // 336b3af rejected it: 'deserialize-tpe-mismatch' (the script typed as Int).
    const bytes = treeBytes(sp(EQ(DC(1, T.Long), long(6))), 0x00)
    expect(hex(bytes)).toBe('00d193d40501050c')
    expect(hex(script)).toBe('9a0402050a')
    expect(evaluate(parseParsedTree(bytes), { extension: var1(script) })).toEqual(TRUE_PROP)
  })
  it('declared Int, in a v0 tree: rejects, the script types as Long', () => {
    // The probe: 00d193d40401040c with variable 1 = 0e059a0402050a, rejected (rule 1000: expected
    // SInt, got the upcast Plus). ergots at 336b3af accepted it.
    const bytes = treeBytes(sp(EQ(DC(1, T.Int), int(6))), 0x00)
    expect(hex(bytes)).toBe('00d193d40401040c')
    const err = captureEvalError(() => evaluate(parseParsedTree(bytes), { extension: var1(script) }))
    expect(err.code).toBe('deserialize-tpe-mismatch')
  })
  it('declared Long, in a v3 tree: rejects, the script types as Int', () => {
    // The probe: 0b07d193d40501050c with variable 1 = 0e059a0402050a, rejected (rule 1000).
    const bytes = treeBytes(sp(EQ(DC(1, T.Long), long(6))), 0x0b)
    expect(hex(bytes)).toBe('0b07d193d40501050c')
    const err = captureEvalError(() => evaluate(parseParsedTree(bytes), { extension: var1(script) }))
    expect(err.code).toBe('deserialize-tpe-mismatch')
  })
})
