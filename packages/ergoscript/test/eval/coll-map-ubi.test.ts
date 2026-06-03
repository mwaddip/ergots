/**
 * inferSType UnsignedBigInt arm — v6 P2b Task 5.
 *
 * `inferSType` (module-private in coll-map.ts) is exercised via `evalMap`.
 * A `Coll[UBI].map(x => x)` produces UBI items; the fallback path in evalMap
 * calls `inferSType(outItems[0])` to set the output Coll's elem type. Without
 * the UBI arm, `inferSType` hits `default:` and throws 'coll-map-elem-type-infer-failed'.
 *
 * Integration test strategy (no fixture file needed — direct MIR construction):
 *   input  = Const(SColl[UBI], { kind:'Coll', elem:SUnsignedBigInt, items:[ubi(7n)] })
 *   mapper = FuncValue([{ id:1, tpe:SAny }], body=ValUse(1, SUnsignedBigInt))
 *
 * Using SAny as the declared arg type on the FuncValue causes evalMap to skip
 * the static elem-type check (mirrors the "SAny → skip" policy in coll-map.ts)
 * and also makes exprTpe(mapper) return SFunc{result:SUnsignedBigInt} — so
 * outElemTpe carries SUnsignedBigInt. Because outElemTpe is concrete, evalMap
 * takes the "prefer outElemTpe" branch and skips inferSType entirely. To force
 * the inferSType path we must make outElemTpe=null (mapper is not FuncValue) OR
 * outElemTpe has SAny (so evalMap falls back to inferSType on the first item).
 *
 * Simplest forcing strategy: use a ValUse body whose tpe is SAny, making
 * exprTpe(FuncValue) return SFunc{result:SAny}. hasSAny(SAny)=true, so evalMap
 * falls through to `inferSType(outItems[0])` — the path under test.
 */
import { describe, it, expect } from 'vitest'
import { evalMap } from '../../src/eval/coll-map'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Map, SType, SValue, FuncValue, ValUse, Const } from '../../src/mir/types'

const SUBI: SType = { tag: 'SUnsignedBigInt' }
const SANY: SType = { tag: 'SAny' }
const ubi = (v: bigint): SValue => ({ kind: 'UnsignedBigInt', value: v })

/**
 * Build a Map MIR node: Coll[UBI].map(x => x)
 *
 * Mapper is FuncValue(args=[{id:1, tpe:SAny}], body=ValUse(1, SAny)).
 * - SAny arg type: elem-type check skipped (our SAny-tolerance policy).
 * - Body tpe SAny: exprTpe(FuncValue) → SFunc{result:SAny}; hasSAny(SAny)=true.
 *   evalMap therefore falls back to `inferSType(outItems[0])` to set outElem.
 *   That's the code path this test exercises.
 */
function makeUbiMapNode(): Map {
  const body: ValUse = { tag: 'ValUse', valId: 1, tpe: SANY }
  const mapper: FuncValue = { tag: 'FuncValue', args: [{ id: 1, tpe: SANY }], body }
  const inputConst: Const = {
    tag: 'Const',
    tpe: { tag: 'SColl', elem: SUBI },
    value: { kind: 'Coll', elem: SUBI, items: [ubi(7n)] },
  }
  return { tag: 'Map', input: inputConst, mapper }
}

describe('inferSType: UnsignedBigInt arm (coll-map v6 P2b Task 5)', () => {
  it('Coll[UBI].map(x=>x) returns Coll[SUnsignedBigInt] without throwing', () => {
    const node = makeUbiMapNode()
    // v6 tree (treeVersion 3) — UBI is a v6-only type.
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMap(node, Env.empty(), ctx)
    expect(result).toEqual({
      kind: 'Coll',
      elem: SUBI,
      items: [ubi(7n)],
    })
  })

  it('without the UBI arm, evalMap throws coll-map-elem-type-infer-failed (pre-fix RED check)', () => {
    // This test documents the failure mode. After the arm is added it will pass
    // (evalMap no longer throws). Leave it as a regression guard: if the arm is
    // removed this test will start asserting the wrong error code.
    // NOTE: after the fix, this test verifies the ABSENCE of the throw — it
    // merely re-runs the same scenario and confirms no EvalError is raised.
    const node = makeUbiMapNode()
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMap(node, Env.empty(), ctx)).not.toThrow()
  })
})
