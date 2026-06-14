/**
 * Tuple arm — JVM-canonical (values.scala:795-808):
 *
 *     if (items.length != 2)
 *       syntax.error(s"Invalid tuple $this")     // BEFORE items, BEFORE cost
 *     val x = item0.evalTo[Any](env)
 *     Value.checkType(item0, x)                  // mirrored (F5 batch 3) — see below
 *     val y = item1.evalTo[Any](env)
 *     Value.checkType(item1, y)                  // mirrored (F5 batch 3) — see below
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
 * checkType class (F5 batch 3 — MIRRORED here): the JVM runs
 * Value.checkType(item, x) after each item eval (values.scala:801,804), which
 * sys.errors for a declared non-pair STuple ("Unsupported tuple type",
 * SType.scala:200-202) and non-unary SFunc types — e.g. a pair Tuple whose
 * item is an inline constant of type (Bool,Bool,Bool) eval-rejects on the JVM.
 * This arm now mirrors it via `assertValueTypeSupported(exprTpe(item))` after
 * each item eval (covers W1 `008602480101010101010402`); the companion seams
 * live in const-placeholder.ts (covers W2), collection.ts, block-value.ts, and
 * val-use.ts. See eval/_check-type.ts.
 * NB the broader tracked F5 class also covers non-checkType mechanisms (e.g.
 * SelectField's runtime Tuple2-only match, transformers.scala:300-307 — handled
 * in select-field.ts, code 'select-field-non-pair'; and the eq-comparer's
 * Coll-representation dispatch for tuple-N values). The FuncValue/Apply
 * param+body SFunc arms remain the documented residual (no SFunc witness).
 *
 * Constant seam, precisely: inline tuple-N constants in positions WITHOUT a
 * JVM checkType (e.g. the tree root) evaluate on both sides — Constant.eval
 * bypasses Tuple.eval and CoreDataSerializer:134-139 has no arity gate. In
 * checkType'd positions (items of pair Tuples here, segregated constants via
 * ConstantPlaceholder.eval values.scala:408-414 in const-placeholder.ts) the
 * JVM rejects — now mirrored.
 */

import type { SValue, Tuple } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { exprTpe } from '../mir/expr-tpe'
import { assertValueTypeSupported } from './_check-type'

export function evalTuple(e: Tuple, env: Env, ctx: EvalContext): SValue {
  if (e.items.length !== 2) {
    // values.scala:797-798 — "Invalid tuple"; v5.0+ supports only pairs.
    throw new EvalError(
      `Tuple arity ${e.items.length} is not evaluable (JVM v5.0+ evaluates only pairs)`,
      'tuple-invalid-arity'
    )
  }
  // values.scala:799-805 — for each item: evalTo, then Value.checkType(item, x).
  // checkType is run against the item's STATIC declared type (node.tpe); a
  // non-pair STuple / non-unary SFunc declared type rejects (the JVM cannot
  // represent such a value). See eval/_check-type.ts.
  const items = e.items.map((item) => {
    const v = evalExpr(item, env, ctx)
    assertValueTypeSupported(exprTpe(item))
    return v
  })
  ctx.addCost(15) // Tuple = Fixed(15), charged AFTER both items (values.scala:806)
  return { kind: 'Tuple', items }
}
