/**
 * SigmaBoolean equality — costed walk + cost-free structural twin (F3 #1).
 *
 * JVM canonical: DataValueComparer.scala (sigmastate-interpreter, data/shared):
 *   - equalSigmaBoolean (:253-282) — MatchType(1) charged ONCE PER NODE at
 *     entry (:255), then dispatch on the LEFT node:
 *       ProveDlog    → r ProveDlog?  equalECPoint : false          (:257-260)
 *       ProveDHTuple → 4 × equalECPoint over (g,h,u,v); Scala &&
 *                      short-circuits on the first unequal point    (:261-266)
 *       TrivialProp  → r TrivialProp? condition == : false          (:267-270)
 *       CAND/COR/CTHRESHOLD guarded on r being the SAME variant
 *       (CTHRESHOLD additionally k == k2 BEFORE the children walk);
 *       a FAILED guard (conjecture left, different right) falls to
 *       `case _ => sys.error(...)` (:278-281) — the JVM THROWS.
 *       Mirrored as EvalError 'sigma-boolean-compare-unsupported',
 *       cost-then-throw (the node MatchType is already charged).
 *       ASYMMETRY (verified): leaf-left vs conjecture-right → false;
 *       conjecture-left vs different-right → throw.
 *   - equalSigmaBooleans (:241-250) — length mismatch → false BEFORE any
 *     child walk (no cost of its own); stops at the first unequal child.
 *   - equalECPoint (:294-300) — EQ_GroupElement FixedCost(172) (:44) per
 *     CALL; short-circuited calls never charge.
 *
 * The cost-free twin `sigmaBooleanStructuralEq` mirrors Scala case-class `==`
 * (the UNCOSTED equality the JVM uses in Coll.indexOf / startsWith /
 * endsWith): same structural recursion, NO costs, NO conjecture-mismatch
 * throw (plain false) — the sys.error lives only in equalSigmaBoolean.
 *
 * ECPoint equality on the 33-byte compressed encodings ergots carries:
 * a 0x00 LEAD byte means the IDENTITY point and bytes 1..32 are never
 * inspected (JVM GroupElementSerializer parses to THE identity object;
 * sigma-rust ec_point.rs:139-151) — two identity encodings with different
 * tails are EQUAL points. Non-identity: SEC1-compressed is canonical, so
 * byte equality ⇔ point equality.
 *
 * Conformance: test/fixtures/conformance/v5/EQ_of_SigmaProp{,_unequal}.json
 * (JVM-blessed 224/740/398 identical + 176/4/176/692/350 unequal).
 */
import type { SigmaBoolean } from '../../mir/types'
import type { EvalContext } from '../eval-context'
import { EvalError } from '../eval-context'

/** Per-node dispatch cost. DataValueComparer.scala:22 `CostOf_MatchType = 1`. */
export const MATCH_TYPE_COST = 1

/** Per-ECPoint-comparison cost. DataValueComparer.scala:44 `EQ_GroupElement = 172`. */
export const EQ_GROUP_ELEMENT_COST = 172

/**
 * Point equality on 33-byte compressed encodings. 0x00-lead = identity
 * (tail bytes consensus-dead); otherwise canonical byte equality.
 */
export function ecPointEqual(a: Uint8Array, b: Uint8Array): boolean {
  const aIdentity = a[0] === 0x00
  const bIdentity = b[0] === 0x00
  if (aIdentity || bIdentity) return aIdentity === bIdentity
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Costed point compare — EQ_GroupElement charged per CALL (scala :294-300). */
function equalECPointCosted(a: Uint8Array, b: Uint8Array, ctx: EvalContext): boolean {
  ctx.addCost(EQ_GROUP_ELEMENT_COST)
  return ecPointEqual(a, b)
}

/** JVM sys.error mirror (DataValueComparer.scala:278-281). */
function throwCompareUnsupported(l: SigmaBoolean, r: SigmaBoolean): never {
  throw new EvalError(
    `cannot compare SigmaBoolean values ${l.tag} and ${r.tag}: unknown type`,
    'sigma-boolean-compare-unsupported'
  )
}

/**
 * The costed equality walk — JVM equalSigmaBoolean (:253-282).
 * Charges MatchType once per node visited, EQ_GroupElement per ECPoint
 * compared; throws 'sigma-boolean-compare-unsupported' on conjecture-left
 * vs different-variant-right (cost-then-throw).
 */
export function equalSigmaBooleanCosted(
  l: SigmaBoolean,
  r: SigmaBoolean,
  ctx: EvalContext
): boolean {
  ctx.addCost(MATCH_TYPE_COST) // once for every node of the tree (:255)
  switch (l.tag) {
    case 'ProveDlog':
      return r.tag === 'ProveDlog' ? equalECPointCosted(l.h, r.h, ctx) : false
    case 'ProveDhTuple': {
      if (r.tag !== 'ProveDhTuple') return false
      // Scala && — short-circuit on first unequal point (:263-264).
      return (
        equalECPointCosted(l.g, r.g, ctx) &&
        equalECPointCosted(l.h, r.h, ctx) &&
        equalECPointCosted(l.u, r.u, ctx) &&
        equalECPointCosted(l.v, r.v, ctx)
      )
    }
    case 'TrivialProp':
      return r.tag === 'TrivialProp' ? l.value === r.value : false
    case 'Cand':
      if (r.tag !== 'Cand') throwCompareUnsupported(l, r)
      return equalSigmaBooleansCosted(l.items, r.items, ctx)
    case 'Cor':
      if (r.tag !== 'Cor') throwCompareUnsupported(l, r)
      return equalSigmaBooleansCosted(l.items, r.items, ctx)
    case 'Cthreshold':
      if (r.tag !== 'Cthreshold') throwCompareUnsupported(l, r)
      // k == sb2.k && children — Scala && skips children on k mismatch (:277).
      return l.k === r.k && equalSigmaBooleansCosted(l.items, r.items, ctx)
    default: {
      const _exhaust: never = l
      throw new Error(`equalSigmaBooleanCosted: unreachable ${JSON.stringify(_exhaust)}`)
    }
  }
}

/**
 * Children-sequence walk — JVM equalSigmaBooleans (:241-250). Length
 * mismatch → false BEFORE walking; stops at the first unequal child.
 */
function equalSigmaBooleansCosted(
  xs: readonly SigmaBoolean[],
  ys: readonly SigmaBoolean[],
  ctx: EvalContext
): boolean {
  if (xs.length !== ys.length) return false
  for (let i = 0; i < xs.length; i++) {
    if (!equalSigmaBooleanCosted(xs[i]!, ys[i]!, ctx)) return false
  }
  return true
}

/**
 * Cost-free structural equality — Scala case-class `==` semantics (the
 * UNCOSTED comparator used by Coll.indexOf / startsWith / endsWith). Same
 * point semantics as the costed walk (identity class), but NO costs and NO
 * conjecture-mismatch throw: any tag mismatch is plain false.
 */
export function sigmaBooleanStructuralEq(l: SigmaBoolean, r: SigmaBoolean): boolean {
  if (l.tag !== r.tag) return false
  switch (l.tag) {
    case 'ProveDlog':
      return ecPointEqual(l.h, (r as typeof l).h)
    case 'ProveDhTuple': {
      const rr = r as typeof l
      return (
        ecPointEqual(l.g, rr.g) &&
        ecPointEqual(l.h, rr.h) &&
        ecPointEqual(l.u, rr.u) &&
        ecPointEqual(l.v, rr.v)
      )
    }
    case 'TrivialProp':
      return l.value === (r as typeof l).value
    case 'Cand':
    case 'Cor': {
      const rr = r as typeof l
      if (l.items.length !== rr.items.length) return false
      for (let i = 0; i < l.items.length; i++) {
        if (!sigmaBooleanStructuralEq(l.items[i]!, rr.items[i]!)) return false
      }
      return true
    }
    case 'Cthreshold': {
      const rr = r as typeof l
      if (l.k !== rr.k || l.items.length !== rr.items.length) return false
      for (let i = 0; i < l.items.length; i++) {
        if (!sigmaBooleanStructuralEq(l.items[i]!, rr.items[i]!)) return false
      }
      return true
    }
    default: {
      const _exhaust: never = l
      throw new Error(`sigmaBooleanStructuralEq: unreachable ${JSON.stringify(_exhaust)}`)
    }
  }
}
