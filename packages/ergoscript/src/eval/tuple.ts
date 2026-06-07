/**
 * Tuple arm — JVM-canonical (values.scala:795-808):
 *
 *     if (items.length != 2)
 *       syntax.error(s"Invalid tuple $this")     // BEFORE items, BEFORE cost
 *     val x = item0.evalTo[Any](env)
 *     Value.checkType(item0, x)                  // NOT yet mirrored — see below
 *     val y = item1.evalTo[Any](env)
 *     Value.checkType(item1, y)                  // NOT yet mirrored — see below
 *     addCost(Tuple.costKind)                    // Fixed(15) AFTER both items
 *
 * In v5.0+ the JVM evaluates only pairs; any other arity (0, 1, 3+) throws
 * before evaluating any item and before charging the envelope, so a failing
 * Tuple arm contributes zero cost.
 *
 * The envelope is charged AFTER the two items — the JVM order (flipped from
 * the inherited sigma-rust charge-first order, 2026-06-07). The two orders are
 * consensus-equivalent: the running cost sum is monotonic and both reach the
 * same total, so neither the limit check nor the final cost can diverge —
 * matching the canonical structure simply ends the documented divergence.
 *
 * Residual divergence (tracked F5 item — checkType class): the JVM also runs
 * Value.checkType(item, x) after each item eval (values.scala:801,804), which
 * sys.errors for declared non-pair STuple ("Unsupported tuple type",
 * SType.scala:200-202) and non-unary SFunc types — e.g. a pair Tuple whose
 * item is an inline constant of type (Bool,Bool,Bool) eval-rejects on the JVM
 * but evaluates here. This arm does NOT yet mirror checkType; the gap spans
 * multiple arms (ConcreteCollection/MethodCall/BlockValue/Apply + the
 * ConstantPlaceholder path, values.scala:408-414) and is tracked as its own
 * F5 ledger item rather than patched per-arm.
 *
 * Constant seam, precisely: inline tuple-N constants in positions WITHOUT a
 * JVM checkType (e.g. the tree root) evaluate on both sides — Constant.eval
 * bypasses Tuple.eval and CoreDataSerializer:134-139 has no arity gate. In
 * checkType'd positions (items of pair Tuples, segregated constants via
 * ConstantPlaceholder.eval values.scala:408-414) the JVM rejects where ergots
 * currently accepts — covered by the F5 item above. Do not "harden" the
 * constant path ad hoc; it must land with the checkType class.
 */

import type { SValue, Tuple } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

export function evalTuple(e: Tuple, env: Env, ctx: EvalContext): SValue {
  if (e.items.length !== 2) {
    // values.scala:797-798 — "Invalid tuple"; v5.0+ supports only pairs.
    throw new EvalError(
      `Tuple arity ${e.items.length} is not evaluable (JVM v5.0+ evaluates only pairs)`,
      'tuple-invalid-arity'
    )
  }
  const items = e.items.map((item) => evalExpr(item, env, ctx))
  ctx.addCost(15) // Tuple = Fixed(15), charged AFTER both items (values.scala:806)
  return { kind: 'Tuple', items }
}
