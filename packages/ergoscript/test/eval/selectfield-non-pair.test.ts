/**
 * SelectField non-pair (F5 batch 3, W3) — `'select-field-non-pair'` reject.
 *
 * JVM `SelectField.eval` (transformers.scala:297-308) matches ONLY a runtime
 * `Tuple2` (a pair). A non-pair tuple (e.g. a 1-tuple `(5,)`, represented as a
 * `Coll[Any]` at runtime) falls through to `Value.typeError` (line 306) →
 * "Invalid type returned by evaluator". Cost (FixedCost(10), line 314) is
 * charged at line 299 — after the child eval but before the Tuple2 match — so
 * the reject is cost-then-throw.
 *
 * ergots over-accepted: a 1-tuple CONSTANT reaching `evalSelectField` had
 * `input.kind === 'Tuple'`, index 1 in range, and returned item 0 (Int 5).
 * The new arity≠2 gate rejects with `'select-field-non-pair'`.
 *
 * JVM-blessed witness (expects ERRORED):
 *   W3 008c6001040a01 (ergoTree v0) = SelectField((5,), 1) where (5,) is a
 *      1-tuple CONSTANT of type STuple([SInt]) (NOT a pair). blessed_by
 *      jvm:sigma-state-6.0.3.
 *
 * STEP 0 finding: W3's SelectField input parses to a 1-tuple Const
 * (kind:'Tuple', items:[Int 5]), NOT a Tuple EXPR node — so batch-1's
 * 'tuple-invalid-arity' (Tuple EXPR gate) and T2's 'unsupported-value-type'
 * (checkType seam) do NOT fire; the over-accept reaches evalSelectField.
 */
import { describe, it, expect } from 'vitest'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, parseParsedTree as parseTree } from '../_helpers'

describe('SelectField non-pair (F5 batch 3, W3)', () => {
  it("W3: SelectField on a 1-tuple constant → 'select-field-non-pair'", () => {
    // 008c6001040a01 — SelectField( Const(STuple([SInt]), (5,)), fieldIndex=1 ).
    // The input is a 1-tuple CONSTANT, not a Tuple EXPR node.
    const tree = parseTree(hexToBytes('008c6001040a01'))
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('select-field-non-pair')
    // Cost-then-throw, total 15 = Const child Fixed(5) + SelectField.costKind
    // Fixed(10). Both are charged before the arity reject (the JVM evals the
    // child at transformers.scala:298, charges SelectField cost at :299, then
    // the Tuple2 match fails at :300). Same total ergots already reported when
    // it OVER-ACCEPTED W3 (returned Int 5 @ cost 15) — now thrown, same cost.
    expect(ctx.jitCost).toBe(15)
  })

  it('positive control: SelectField on a valid pair still returns the field', () => {
    // Hand-built MIR: SelectField(Tuple(Int(5), Int(99)), fieldIndex=2) → 99.
    const tree = {
      header: { version: 0 as const, hasSize: false, constantSegregation: false, rawHeader: 0 },
      constants: [] as [],
      constantTypes: [] as [],
      body: {
        tag: 'SelectField' as const,
        input: {
          tag: 'Tuple' as const,
          items: [
            { tag: 'Const' as const, tpe: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 5 } },
            { tag: 'Const' as const, tpe: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 99 } },
          ],
        },
        fieldIndex: 2,
      },
    }
    const result = evaluate(tree)
    expect(result).toEqual({ kind: 'Int', value: 99 })
  })

  it("non-pair arity-1 Tuple value (hand-built) → 'select-field-non-pair'", () => {
    // Hand-built MIR mirroring W3's runtime shape: a 1-tuple Tuple VALUE.
    const tree = {
      header: { version: 0 as const, hasSize: false, constantSegregation: false, rawHeader: 0 },
      constants: [] as [],
      constantTypes: [] as [],
      body: {
        tag: 'SelectField' as const,
        input: {
          tag: 'Const' as const,
          tpe: { tag: 'STuple' as const, items: [{ tag: 'SInt' as const }] },
          value: { kind: 'Tuple' as const, items: [{ kind: 'Int' as const, value: 5 }] },
        },
        fieldIndex: 1,
      },
    }
    const err = captureEvalError(() => evaluate(tree))
    expect(err.code).toBe('select-field-non-pair')
  })

  it("non-pair arity-3 Tuple value (hand-built) → 'select-field-non-pair'", () => {
    const tree = {
      header: { version: 0 as const, hasSize: false, constantSegregation: false, rawHeader: 0 },
      constants: [] as [],
      constantTypes: [] as [],
      body: {
        tag: 'SelectField' as const,
        input: {
          tag: 'Const' as const,
          tpe: {
            tag: 'STuple' as const,
            items: [{ tag: 'SInt' as const }, { tag: 'SInt' as const }, { tag: 'SInt' as const }],
          },
          value: {
            kind: 'Tuple' as const,
            items: [
              { kind: 'Int' as const, value: 1 },
              { kind: 'Int' as const, value: 2 },
              { kind: 'Int' as const, value: 3 },
            ],
          },
        },
        fieldIndex: 2,
      },
    }
    const err = captureEvalError(() => evaluate(tree))
    expect(err.code).toBe('select-field-non-pair')
  })

  it("non-Tuple input still throws 'select-field-input-not-tuple'", () => {
    // The distinct non-Tuple-input check is unchanged by the arity gate.
    const tree = {
      header: { version: 0 as const, hasSize: false, constantSegregation: false, rawHeader: 0 },
      constants: [] as [],
      constantTypes: [] as [],
      body: {
        tag: 'SelectField' as const,
        input: { tag: 'Const' as const, tpe: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 5 } },
        fieldIndex: 1,
      },
    }
    const err = captureEvalError(() => evaluate(tree))
    expect(err.code).toBe('select-field-input-not-tuple')
  })
})
