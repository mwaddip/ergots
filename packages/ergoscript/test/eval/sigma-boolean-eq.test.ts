/**
 * Costed SigmaBoolean equality walk (F3 root cause #1) — unit pins.
 *
 * JVM canonical: DataValueComparer.scala equalSigmaBoolean (:253-282) —
 * MatchType(1) per node + EQ_GroupElement(172) per ECPoint compared, &&
 * short-circuit, conjecture-left vs different-variant-right = sys.error
 * (:278-281, mirrored as EvalError 'sigma-boolean-compare-unsupported').
 * Conformance twins: test/fixtures/conformance/v5/authored/EQ_of_SigmaProp{,_unequal}.json
 * (blessed 224/740/398 + 176/4/176/692/350). Costs here are the WALK only
 * (outer MatchType + nodes), no tree envelope.
 */
import { describe, it, expect } from 'vitest'
import { sValueEquals, sValueStructuralEq, primitiveValueEqual } from '../../src/eval/bin-op/relation'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SValue, SigmaBoolean } from '../../src/mir/types'

// 33-byte compressed points (distinct, valid-shaped; the comparer never
// decodes non-identity points, so any non-zero-lead 33-byte string works).
const P1 = new Uint8Array([0x02, ...Array.from({ length: 32 }, (_, i) => i + 1)])
const P2 = new Uint8Array([0x03, ...Array.from({ length: 32 }, (_, i) => i + 1)])
// Identity encodings: 0x00 lead — bytes 1..32 are consensus-dead garbage.
const ID_A = new Uint8Array([0x00, ...Array.from({ length: 32 }, () => 0xaa)])
const ID_B = new Uint8Array([0x00, ...Array.from({ length: 32 }, () => 0xbb)])

const dlog = (h: Uint8Array): SigmaBoolean => ({ tag: 'ProveDlog', h })
const dht = (g: Uint8Array, h: Uint8Array, u: Uint8Array, v: Uint8Array): SigmaBoolean =>
  ({ tag: 'ProveDhTuple', g, h, u, v })
const cand = (items: SigmaBoolean[]): SigmaBoolean => ({ tag: 'Cand', items })
const cor = (items: SigmaBoolean[]): SigmaBoolean => ({ tag: 'Cor', items })
const cthreshold = (k: number, items: SigmaBoolean[]): SigmaBoolean =>
  ({ tag: 'Cthreshold', k, items })
const trivial = (value: boolean): SigmaBoolean => ({ tag: 'TrivialProp', value })

const sp = (value: SigmaBoolean): SValue => ({ kind: 'SigmaProp', value })

/** sValueEquals over two SigmaProps; returns [result, jitCost]. */
function eqCosted(l: SigmaBoolean, r: SigmaBoolean): [boolean, number] {
  const ctx = makeContext()
  const res = sValueEquals(sp(l), sp(r), ctx)
  return [res, ctx.jitCost]
}

describe('equalSigmaBooleanCosted — leaf arms (DataValueComparer.scala:257-270)', () => {
  it('identical ProveDlog: outer(1) + node(1) + EC(172) = 174, true', () => {
    expect(eqCosted(dlog(P1), dlog(P1))).toEqual([true, 174])
  })
  it('unequal ProveDlog: same 174 (the EC compare is charged), false', () => {
    expect(eqCosted(dlog(P1), dlog(P2))).toEqual([false, 174])
  })
  it('identical ProveDHTuple: outer + node + 4×172 = 690, true', () => {
    expect(eqCosted(dht(P1, P1, P1, P1), dht(P1, P1, P1, P1))).toEqual([true, 690])
  })
  it('DHT mismatch at g: && short-circuits after EC #1 → 174, false', () => {
    expect(eqCosted(dht(P2, P1, P1, P1), dht(P1, P1, P1, P1))).toEqual([false, 174])
  })
  it('DHT mismatch at v: all 4 ECs compared → 690, false', () => {
    expect(eqCosted(dht(P1, P1, P1, P2), dht(P1, P1, P1, P1))).toEqual([false, 690])
  })
  it('node-TYPE mismatch dlog-vs-dht: NO ECPoint → outer + node = 2, false', () => {
    expect(eqCosted(dlog(P1), dht(P1, P1, P1, P1))).toEqual([false, 2])
  })
  it('TrivialProp pair: condition compare, no extra cost → 2', () => {
    expect(eqCosted(trivial(true), trivial(true))).toEqual([true, 2])
    expect(eqCosted(trivial(true), trivial(false))).toEqual([false, 2])
  })
  it('TrivialProp-vs-dlog (leaf-left mismatch): false, NOT a throw → 2', () => {
    expect(eqCosted(trivial(true), dlog(P1))).toEqual([false, 2])
  })
})

describe('equalSigmaBooleanCosted — identity ECPoint class (0x00-lead, tails dead)', () => {
  it('two identity encodings with different garbage tails are EQUAL → 174, true', () => {
    expect(eqCosted(dlog(ID_A), dlog(ID_B))).toEqual([true, 174])
  })
  it('identity vs non-identity: unequal → 174, false', () => {
    expect(eqCosted(dlog(ID_A), dlog(P1))).toEqual([false, 174])
  })
})

describe('equalSigmaBooleanCosted — conjecture arms (DataValueComparer.scala:271-281)', () => {
  it('CAND second-child ECPoint mismatch: both children walked → 348, false', () => {
    // outer(1) + cand(1) + child1(1+172, equal) + child2(1+172, unequal)
    expect(eqCosted(cand([dlog(P1), dlog(P1)]), cand([dlog(P1), dlog(P2)]))).toEqual([false, 348])
  })
  it('CAND first-child mismatch: children walk stops → 175, false', () => {
    // outer(1) + cand(1) + child1(1+172, unequal); child2 never visited
    expect(eqCosted(cand([dlog(P2), dlog(P1)]), cand([dlog(P1), dlog(P1)]))).toEqual([false, 175])
  })
  it('CAND length mismatch: false before any child walk → 2', () => {
    expect(eqCosted(cand([dlog(P1), dlog(P1)]), cand([dlog(P1)]))).toEqual([false, 2])
  })
  it('COR pair: same walk shape as CAND → 175 for 1 equal child', () => {
    // outer(1) + cor(1) + child(1+172)
    expect(eqCosted(cor([dlog(P1)]), cor([dlog(P1)]))).toEqual([true, 175])
  })
  it('CTHRESHOLD k mismatch: children NOT walked → 2, false', () => {
    expect(eqCosted(cthreshold(1, [dlog(P1), dlog(P1)]), cthreshold(2, [dlog(P1), dlog(P1)]))).toEqual([false, 2])
  })
  it('CTHRESHOLD equal: k matches then children walk → 348, true', () => {
    expect(eqCosted(cthreshold(2, [dlog(P1), dlog(P1)]), cthreshold(2, [dlog(P1), dlog(P1)]))).toEqual([true, 348])
  })
  it('nested conjecture: cand([cor([dlog])]) walk recurses → 176, true', () => {
    // outer(1) + cand(1) + cor(1) + dlog(1+172) = 176
    expect(eqCosted(cand([cor([dlog(P1)])]), cand([cor([dlog(P1)])]))).toEqual([true, 176])
  })
})

describe('equalSigmaBooleanCosted — conjecture-vs-other THROWS (JVM sys.error :278-281)', () => {
  it('CAND-vs-dlog throws sigma-boolean-compare-unsupported, cost charged before throw', () => {
    const ctx = makeContext()
    let err: unknown
    try {
      sValueEquals(sp(cand([dlog(P1)])), sp(dlog(P1)), ctx)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EvalError)
    expect((err as EvalError).code).toBe('sigma-boolean-compare-unsupported')
    expect(ctx.jitCost).toBe(2) // outer MatchType + node MatchType, then throw
  })
  it('the ASYMMETRY: dlog-vs-CAND is false (leaf arm inner case _), NOT a throw → 2', () => {
    expect(eqCosted(dlog(P1), cand([dlog(P1)]))).toEqual([false, 2])
  })
  it('COR-vs-CAND and CTHRESHOLD-vs-CAND throw too', () => {
    expect(() => eqCosted(cor([dlog(P1)]), cand([dlog(P1)]))).toThrow(EvalError)
    expect(() => eqCosted(cthreshold(1, [dlog(P1)]), cand([dlog(P1)]))).toThrow(EvalError)
  })
  it('a nested conjecture-vs-leaf mismatch inside children propagates the throw', () => {
    // cand([cand([dlog])]) vs cand([dlog]): child pair is Cand-vs-ProveDlog → throw
    expect(() => eqCosted(cand([cand([dlog(P1)])]), cand([dlog(P1)]))).toThrow(EvalError)
  })
})

describe('cost-free structural twin (Scala case-class ==): no costs, no throws', () => {
  it('sValueStructuralEq: conjecture-vs-leaf is plain false (NOT a throw)', () => {
    expect(sValueStructuralEq(sp(cand([dlog(P1)])), sp(dlog(P1)))).toBe(false)
  })
  it('sValueStructuralEq: identity-class equality holds on the uncosted path too', () => {
    expect(sValueStructuralEq(sp(dlog(ID_A)), sp(dlog(ID_B)))).toBe(true)
  })
  it('primitiveValueEqual (box-register / Coll-bulk path): structural compare, k respected on Cthreshold', () => {
    expect(primitiveValueEqual(sp(cthreshold(1, [dlog(P1)])), sp(cthreshold(1, [dlog(P1)])))).toBe(true)
    expect(primitiveValueEqual(sp(cthreshold(1, [dlog(P1)])), sp(cthreshold(1, [dlog(P2)])))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fix 1: bare GroupElement EQ — identity ECPoint class (review fix)
// ---------------------------------------------------------------------------
// GE scalar dispatch (compareSValues 'GroupElement' arm): flat EQ_GROUP_ELEMENT_COST(172),
// no MatchType — DataValueComparer.scala:340-341 `addFixedCost(EQ_GroupElement)` only.
// Coll[GE] bulk path (primitiveValueEqual): uncosted; sValueEquals Coll arm charges
// COLL_MATCH_TYPE_COST(1) + addPerItemJitCost({base:15,perChunk:5,chunkSize:1}, n).
// n=1: chunks = (1-1)/1+1 = 1; cost = 15 + 1*5 = 20; total Coll cost = 1 + 20 = 21.
// ---------------------------------------------------------------------------

const ge = (v: Uint8Array): SValue => ({ kind: 'GroupElement', value: v })
const collGe = (items: SValue[]): SValue => ({ kind: 'Coll', elem: { tag: 'SGroupElement' }, items })

function geCosted(a: SValue, b: SValue): [boolean, number] {
  const ctx = makeContext()
  const res = sValueEquals(a, b, ctx)
  return [res, ctx.jitCost]
}

describe('bare GroupElement EQ — identity ECPoint class (review fix)', () => {
  it('GE(ID_A) == GE(ID_B): 0x00-lead → identity class → true, cost 172 (flat EQ_GroupElement, no MatchType)', () => {
    // DataValueComparer.scala:340-341: addFixedCost(EQ_GroupElement=172) then equalGroupElement
    // (object equality on parsed identity points) — no MatchType wrapping at this arm.
    expect(geCosted(ge(ID_A), ge(ID_B))).toEqual([true, 172])
  })
  it('GE(ID_A) == GE(P1): identity vs non-identity → false, cost 172', () => {
    expect(geCosted(ge(ID_A), ge(P1))).toEqual([false, 172])
  })
  it('primitiveValueEqual GE(ID_A) == GE(ID_B): identity class → true (Coll bulk / register path)', () => {
    expect(primitiveValueEqual(ge(ID_A), ge(ID_B))).toBe(true)
  })
  it('Coll[GE]([ID_A]) == Coll[GE]([ID_B]): identity elements equal → true, cost 21', () => {
    // COLL_MATCH_TYPE_COST(1) + addPerItemJitCost({base:15,perChunk:5,chunkSize:1}, n=1)
    // = 1 + (15 + ceil(1/1)*5) = 1 + 15 + 5 = 21
    expect(geCosted(collGe([ge(ID_A)]), collGe([ge(ID_B)]))).toEqual([true, 21])
  })
})
