/**
 * `AtLeast` evaluator arm — THRESHOLD sigma combinator.
 *
 * `AtLeast { bound: Expr<SInt>, input: Expr<SColl[SSigmaProp]> }` evaluates
 * the bound integer k and the input collection of SigmaProps, then reduces
 * via `cthresholdReduce(k, items)`.
 *
 * JVM path at 6.0.7:
 *   `AtLeast.eval` (`data/shared/src/main/scala/sigma/ast/trees.scala:314-320`)
 *     val b     = bound.evalTo[Int](env)
 *     val props = input.evalTo[Coll[SigmaProp]](env)
 *     addSeqCost(AtLeast.costKind, props.length) { () =>
 *       SigmaDsl.atLeast(b, props)
 *     }
 *   `SigmaDsl.atLeast` (`data/shared/src/main/scala/sigma/data/
 *     CSigmaDslBuilder.scala:102-108`)
 *     if (props.length > AtLeast.MaxChildrenCount) throw IllegalArgumentException
 *     val sigmaTrees = toSigmaTrees(props.toArray)       // Array[SigmaProp] cast
 *     val tree       = AtLeast.reduce(bound, sigmaTrees)
 *     CSigmaProp(tree)
 *   `AtLeast.reduce` (`trees.scala:340-359`)
 *     if (bound <= 0)       return TrueProp
 *     if (bound > nChildren) return FalseProp
 *     require(nChildren <= MaxChildrenCount)
 *     ... Cthreshold / COR / CAND normalization
 *
 * The `addSeqCost` envelope charges the Pattern-B cost BEFORE the body runs,
 * so the 255-cap throw, the array cast and the degenerate-bound short-
 * circuits all run on a charged context. The cost is sized by `props.length`,
 * so a `Coll[SigmaProp]` and a `Coll[Any]` of the same length pay the same.
 *
 * Error codes:
 *   'atleast-bound-not-int'         — bound evaluates to a non-Int
 *   'sigma-prop-input-not-coll'     — input evaluates to a non-Coll (the
 *                                     JVM's `evalTo[Coll[SigmaProp]]` first
 *                                     check at type-erased runtime)
 *   'atleast-too-many-children'     — items.length > 255 (SigmaDsl.atLeast's
 *                                     IllegalArgumentException, before the
 *                                     cast)
 *   'coll-class-cast'               — the backing array is of another class
 *                                     (SigmaDsl.atLeast's `props.toArray`
 *                                     cast to `Array[SigmaProp]`; a tuple's
 *                                     `Coll[Any]` over `Object[]` throws)
 *   'sigma-prop-coll-elem-not-sigma-prop'
 *                                   — defensive per-item check once the
 *                                     array cast has passed, against a
 *                                     mislabelled item from
 *                                     `ConstantPlaceholder` injection
 */

import type { Atleast, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { cthresholdReduce } from '../mir/sigma-boolean-normalize'
import { castArray } from './_coll'
import { expectSigmaProp } from './_sigma-helpers'

export function evalAtleast(e: Atleast, env: Env, ctx: EvalContext): SValue {
  // Step 1: eval bound expression — must be Int (`trees.scala:315`).
  const boundV = evalExpr(e.bound, env, ctx)
  if (boundV.kind !== 'Int') {
    throw new EvalError(
      `AtLeast: expected Int bound, got ${boundV.kind}`,
      'atleast-bound-not-int',
    )
  }

  // Step 2: eval input expression — must be a `Coll` at the type-erased level
  // (`trees.scala:316`, `evalTo[Coll[SigmaProp]]`).
  const inputV = evalExpr(e.input, env, ctx)
  if (inputV.kind !== 'Coll') {
    throw new EvalError(
      `AtLeast: expected Coll[SigmaProp], got ${inputV.kind}`,
      'sigma-prop-input-not-coll',
    )
  }

  // Step 3: Pattern B — `addSeqCost(AtLeast.costKind, props.length)` at
  // `trees.scala:317` charges before the body runs. `costKind =
  // PerItemCost(20, 3, 5)` (`trees.scala:326-327`).
  ctx.addPerItemCost(20, 3, 5, inputV.items.length)

  // Step 4: `SigmaDsl.atLeast`'s length check
  // (`CSigmaDslBuilder.scala:103-104`) throws BEFORE the array cast.
  // `MaxChildrenCountForAtLeastOp = 255` (`SigmaConstants.scala:65`);
  // CTHRESHOLD's GF(2^192) polynomial arithmetic takes single-byte inputs,
  // so >255 children are unrepresentable.
  if (inputV.items.length > 255) {
    throw new EvalError(
      `AtLeast: ${inputV.items.length} children exceeds MaxChildrenCount (255)`,
      'atleast-too-many-children',
    )
  }

  // Step 5: `SigmaDsl.atLeast`'s `props.toArray` cast to `Array[SigmaProp]`
  // (`CSigmaDslBuilder.scala:105`, `toSigmaTrees`'s signature at `:90`). A
  // collection whose backing array is of another class — `Object[]` from a
  // tuple's `Coll[Any]` — throws a `ClassCastException` here, before
  // `AtLeast.reduce`'s degenerate-bound short-circuits run.
  const items = castArray(inputV, 'SigmaProp', 'AtLeast')
  const sigmaBooleans = items.map((sv, i) =>
    expectSigmaProp(sv, `AtLeast item ${i}`),
  )

  // Step 6: `AtLeast.reduce`'s degenerate-bound short-circuits
  // (`trees.scala:342-344`): `bound <= 0` returns `TrueProp`;
  // `bound > nChildren` returns `FalseProp`.
  const k = boundV.value
  if (k <= 0) {
    return { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
  }
  if (k > sigmaBooleans.length) {
    return { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: false } }
  }

  // Step 7: reduce via `Cthreshold::reduce` — handles the degenerate
  // collapses `k == 1 -> Cor`, `k == n -> Cand` and `TrivialProp` partial
  // evaluation (`trees.scala:363-394`).
  return { kind: 'SigmaProp', value: cthresholdReduce(k, sigmaBooleans) }
}
