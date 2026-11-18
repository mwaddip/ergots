/**
 * ModQ, PlusModQ and MinusModQ arms — unconditional eval-reject.
 *
 * The JVM 6.0.7 has NO eval for `ModQ` or `ModQArithOp`. Neither class
 * (ast/trees.scala:954-970) overrides `eval`, and each companion carries a
 * `FixedCost(JitCost(1))` alone; no site invokes `Value.eval`'s override, so
 * the default fires and throws (ast/values.scala:101-102). EVERY evaluation
 * throws JVM-side, at tree v0 and at v3, whatever the operand kinds: the
 * class holds a `// TODO v6.0: implement modular operations`
 * (ast/trees.scala:953) and nothing has implemented it. The three nodes still
 * PARSE (the JVM parses them to keep `ModQSerializer` and
 * `ModQArithOpSerializer` in the dispatch table, so a transaction whose
 * output carries one of them parses).
 *
 * Cost: NOTHING is charged before the throw (there is no cost site to reach),
 * and the operand is not evaluated: an operand that would throw differently
 * is never reached.
 */

import type { ModQ, ModQArith } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalModQ(_e: ModQ, _env: Env, _ctx: EvalContext): never {
  // JVM: no eval override (ast/trees.scala:954-963), so `Value.eval` throws
  // (ast/values.scala:101-102). Charge nothing, evaluate no operand.
  throw new EvalError('ModQ has no JVM eval', 'unsupported-eval-node')
}

export function evalModQArith(_e: ModQArith, _env: Env, _ctx: EvalContext): never {
  // JVM: no eval override on `ModQArithOp` (ast/trees.scala:965-970), so
  // `Value.eval` throws for both `PlusModQ` and `MinusModQ`
  // (ast/values.scala:101-102). Charge nothing, evaluate no operand.
  throw new EvalError('ModQArith has no JVM eval', 'unsupported-eval-node')
}
