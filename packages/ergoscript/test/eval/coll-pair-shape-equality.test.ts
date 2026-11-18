/**
 * Equality of a pair collection and its mapped form, through the evaluator.
 *
 * `EQ` / `NEQ` go through `DataValueComparer.equalDataValues` at
 * `data/shared/src/main/scala/sigma/ast/trees.scala:1209, :1229`. For two
 * `Coll[(L, R)]` of same length and same `tItem`, `equalDataValues`'s Coll
 * arm dispatches through `equalColls_Dispatch`
 * (`data/shared/src/main/scala/sigma/data/DataValueComparer.scala:200-239`),
 * whose `pairRType` case has no primitive match and is not in `descriptors`
 * (the 7 reference descriptor types only): dispatch falls to the generic
 * `equalColls` (`:183-196`), which walks `c1(i)` against `c2(i)` via
 * `equalDataValues`. For a `PairOfCols` operand `coll(i)` yields a fresh
 * `(ls(i), rs(i))` Tuple2; for a `CollOverArray[(L, R)]` it yields the stored
 * Tuple2. Both reduce through the Tuple2 arm (`:316-327`), item by item. The
 * pair-shape rule in `CollsOverArrays.scala:142-154, :276-287` lives on
 * `Coll.equals`, which the comparer does not call.
 *
 * Measured with the 6.0.7 JVM probe at REAL tree versions 0, 1, 2, 3 (header
 * bytes `0x08`, `0x09`, `0x0a`, `0x0b`; `ErgoTree.getVersion` is `h & 0x07`,
 * `data/shared/src/main/scala/sigma/ast/ErgoTree.scala:261`, so the header's
 * low 3 bits are the version `fullReduction` reads from
 * `VersionContext.current` at `:29`). A 2-item `Coll[(Int, Int)]` constant
 * equals its own `map(x => x)` as `TrueProp` under `BoolToSigmaProp` at each
 * of those tree versions; `NEQ` of the same is `FalseProp`.
 *
 * The `sValueEquals` arm's cost does not read `ctx.treeVersion` at all (the
 * Coll arm of `src/eval/bin-op/relation.ts` has no version branch), so the
 * loop over `[0, 1, 2, 3]` below is one assertion written at four versions:
 * it pins that the arm takes the same Boolean and the same cost at each.
 *
 * The arm's cost on a 2-pair `Coll[(Int, Int)]`:
 *   `COLL_MATCH_TYPE_COST(1)` paid up front;
 *   for `elem = STuple`, no COA bulk path (`isCoaCollElem` returns false),
 *   item-wise recursion through `compareSValues`;
 *   `addPerItemJitCost(EQ_COLL_DEFAULT_PER_ITEM={10,2,1}, compared)` after
 *   the loop;
 *   per pair = `EQ_TUPLE_COST(4)` + 2 * `EQ_PRIM_COST(3)` = 10;
 *   two pairs = 20;
 *   outer coll total = 1 + 20 + (10 + 2 * ceil(2/1)) = 1 + 20 + 14 = 35.
 */
import { describe, expect, it } from 'vitest'
import { sValueEquals } from '../../src/eval/bin-op/relation'
import { makeContext } from '../../src/eval/eval-context'
import type { SType, SValue } from '../../src/mir/types'
import { collOverArray, fromData, type CollValue } from '../../src/coll'

const SINT: SType = { tag: 'SInt' }
const PAIR_II: SType = { tag: 'STuple', items: [SINT, SINT] }

const int = (n: number): SValue => ({ kind: 'Int', value: n })
const pair = (a: number, b: number): SValue => ({ kind: 'Tuple', items: [int(a), int(b)] })

/**
 * A `Coll[(Int, Int)]` as the data reader builds it: a `PairOfCols` whose
 * sides are plain (`CollsOverArrays.scala:205-215, :226-233` via `fromData`
 * at `CoreDataSerializer.deserializeColl` :172-190).
 */
function pairConstColl(items: Array<[number, number]>): CollValue {
  return fromData(PAIR_II, items.map(([a, b]) => pair(a, b)))
}

/**
 * The same items as a plain `CollOverArray[(Int, Int)]`, which is what
 * `PairOfCols.map(x => x)` builds (`CollsOverArrays.scala:317-324`): a plain
 * `new CollOverArray(res, builder)` with no pair routing.
 */
function mappedPairColl(items: Array<[number, number]>): CollValue {
  return collOverArray(PAIR_II, items.map(([a, b]) => pair(a, b)))
}

const SAMPLE: Array<[number, number]> = [[1, 2], [3, 4]]

describe('the EQ arm does not branch on the tree version: the direct pair-vs-mapped case', () => {
  // The Boolean is pinned by the probe's tree-vN line, as noted on each
  // assertion. The 35 cost is the arm's own composition on the input: the
  // arm reads no `ctx.treeVersion`, so the four tree versions share one
  // path through `sValueEquals`'s Coll arm, and this is the assertion that
  // pins that the arm takes the same Boolean and the same cost at each
  // version.
  const EXPECTED_EQ_COST = 35

  for (const treeVersion of [0, 1, 2, 3]) {
    describe(`tree version ${treeVersion}`, () => {
      it('EQ(pair, pair.map(x=>x)) is true (probe line "EQ pair=mapped, tree v' + treeVersion + '" reduces to TrueProp)', () => {
        const ctx = makeContext({ treeVersion })
        const eq = sValueEquals(pairConstColl(SAMPLE), mappedPairColl(SAMPLE), ctx)
        expect(eq).toBe(true)
        expect(ctx.jitCost).toBe(EXPECTED_EQ_COST)
      })

      it('EQ(pair.map(x=>x), pair) is true (same probe line by symmetry of `equalDataValues`\'s Coll arm, which takes l and r as Coll[_] equivalently)', () => {
        const ctx = makeContext({ treeVersion })
        const eq = sValueEquals(mappedPairColl(SAMPLE), pairConstColl(SAMPLE), ctx)
        expect(eq).toBe(true)
        expect(ctx.jitCost).toBe(EXPECTED_EQ_COST)
      })

      it('NEQ(pair, pair.map(x=>x)) is false (probe line "NEQ pair!=mapped, tree v' + treeVersion + '" reduces to FalseProp)', () => {
        // `sValueEquals` returns the EQ; the NEQ arm in `evalRelationOp` is
        // `!eq`, so an equal pair gives NEQ false. Charge matches EQ.
        const ctx = makeContext({ treeVersion })
        const eq = sValueEquals(pairConstColl(SAMPLE), mappedPairColl(SAMPLE), ctx)
        expect(!eq).toBe(false)
        expect(ctx.jitCost).toBe(EXPECTED_EQ_COST)
      })

      it('EQ(pair, pair) same shape on both sides is true (the arm takes the item-walk path for either input shape)', () => {
        const ctx = makeContext({ treeVersion })
        const eq = sValueEquals(pairConstColl(SAMPLE), pairConstColl(SAMPLE), ctx)
        expect(eq).toBe(true)
        expect(ctx.jitCost).toBe(EXPECTED_EQ_COST)
      })

      it('EQ(mapped, mapped) both array shape over Tuple2 is true (same path, same cost)', () => {
        const ctx = makeContext({ treeVersion })
        const eq = sValueEquals(mappedPairColl(SAMPLE), mappedPairColl(SAMPLE), ctx)
        expect(eq).toBe(true)
        expect(ctx.jitCost).toBe(EXPECTED_EQ_COST)
      })
    })
  }
})

describe('pair vs mapped nested in a Coll — the arm composes without a version branch', () => {
  // `Coll[Coll[(Int, Int)]]` of length 1, inner shapes differing. The outer
  // comparer recurses the inner compare through `equalDataValues` case 2
  // (`DataValueComparer.scala:316-327`), not through `Coll.equals`, so again
  // the pair-shape rule is not reached at any tree version. Boolean is
  // derived from the direct pair-vs-mapped probe line at each of v0..v3 by
  // the same arm composition the direct case exercises; cost is the arm's
  // own rule on nested recursion (one inner compare + outer `addPerItemJitCost`
  // on n=1).
  const INNER_ELEM: SType = { tag: 'SColl', elem: PAIR_II }
  const INNER_COST = 35
  const OUTER_COST = 1 /* outer MATCH */ + INNER_COST + (10 + 2 * 1) /* outer addPerItem n=1 */
  // = 1 + 35 + 12 = 48

  for (const treeVersion of [0, 3]) {
    it(`tree v${treeVersion}: Coll[Coll[(Int,Int)]] inner pair vs inner mapped is true, cost ${OUTER_COST} (derived from "EQ pair=mapped, tree v${treeVersion}" by the arm's composition)`, () => {
      const outerPairInner: CollValue = {
        kind: 'Coll',
        elem: INNER_ELEM,
        items: [pairConstColl(SAMPLE)],
        cls: { shape: 'array', specialised: false, array: 'Coll' },
      }
      const outerMappedInner: CollValue = {
        kind: 'Coll',
        elem: INNER_ELEM,
        items: [mappedPairColl(SAMPLE)],
        cls: { shape: 'array', specialised: false, array: 'Coll' },
      }
      const ctx = makeContext({ treeVersion })
      const eq = sValueEquals(outerPairInner, outerMappedInner, ctx)
      expect(eq).toBe(true)
      expect(ctx.jitCost).toBe(OUTER_COST)
    })
  }
})

describe('pair vs mapped inside an Option — the arm composes without a version branch', () => {
  // `Option[Coll[(Int, Int)]]`, Some on both sides, inner shapes differ.
  // Comparer: `equalDataValues` case 7 (Option) at `:361-385` — fixed cost
  // `EQ_OPTION_COST(4)`, then recurse `equalDataValues(opt1.get, opt2.get)`
  // which is one inner Coll compare. No `Coll.equals` call. Boolean is
  // derived from "EQ pair=mapped, tree v{N}" by the arm's composition.
  const OPT_ELEM: SType = { tag: 'SOption', elem: PAIR_II }
  const OPT_COST = 4 + 35 // EQ_OPTION_COST + inner Coll compare

  for (const treeVersion of [0, 3]) {
    it(`tree v${treeVersion}: Some(pair) == Some(mapped) is true, cost ${OPT_COST}`, () => {
      const left: SValue = { kind: 'Option', elem: OPT_ELEM, value: pairConstColl(SAMPLE) }
      const right: SValue = { kind: 'Option', elem: OPT_ELEM, value: mappedPairColl(SAMPLE) }
      const ctx = makeContext({ treeVersion })
      const eq = sValueEquals(left, right, ctx)
      expect(eq).toBe(true)
      expect(ctx.jitCost).toBe(OPT_COST)
    })
  }
})

describe('pair vs mapped inside a Tuple — the arm composes without a version branch', () => {
  // Tuple of two Coll[(Int, Int)]. Comparer: `equalDataValues` case 3
  // (Tuple2) at `:316-327` — EQ_TUPLE_COST(4), then recurse each component
  // via `equalDataValues`, which enters the Coll arm and dispatches to the
  // generic item-walk. No `Coll.equals` call. Boolean is derived from
  // "EQ pair=mapped, tree v{N}" by the arm's composition.
  const TUP_COST = 4 /* EQ_TUPLE_COST */ + 35 + 35

  for (const treeVersion of [0, 3]) {
    it(`tree v${treeVersion}: (pair, pair) == (mapped, mapped) is true, cost ${TUP_COST}`, () => {
      const left: SValue = {
        kind: 'Tuple',
        items: [pairConstColl(SAMPLE), pairConstColl(SAMPLE)],
      }
      const right: SValue = {
        kind: 'Tuple',
        items: [mappedPairColl(SAMPLE), mappedPairColl(SAMPLE)],
      }
      const ctx = makeContext({ treeVersion })
      const eq = sValueEquals(left, right, ctx)
      expect(eq).toBe(true)
      expect(ctx.jitCost).toBe(TUP_COST)
    })
  }
})
