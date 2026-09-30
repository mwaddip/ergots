/**
 * BitInversion arm — unconditional eval-reject.
 *
 * The JVM 6.0.6 has NO eval for BitInversion. The class (trees.scala:899-903,
 * marked "Not implemented in v4.x" at :898) overrides no `eval`, and its companion
 * has `costKind = Value.notSupportedError(this, "costKind")` (trees.scala:906), so
 * the default `Value.eval` runs and throws `sys.error("Should be overriden in
 * ...")` (values.scala:101-102). EVERY evaluation throws JVM-side, at tree v0 and
 * at v3, whatever the operand's kind: a local sigma-state 6.0.6 probe (spend mode)
 * rejects it at reduce, and accepts the same node in a branch that is never
 * evaluated. The node still PARSES (the JVM builds it; its `require` is a
 * wire-layer check, wire/check-build.ts).
 *
 * Cost: NOTHING is charged before the throw (there is no cost site to reach), and
 * the operand is not evaluated: an operand that would throw differently is never
 * reached. Spec: docs/specs/2026-09-30-jvm-node-construction-design.md §9.
 *
 * The v6 `X.bitwiseInverse` method (method id 8, a property call;
 * eval/_numeric-v6.ts) is the evaluated form: the JVM evaluates it. It shares no
 * code with this arm and is unchanged.
 *
 * History: until 2026-09-30 this arm followed sigma-rust (bit_inversion.rs:15): a
 * Fixed(1) envelope, then the operand, then the bitwise complement masked to the
 * operand's kind, which is an over-accept against the JVM.
 */

import type { BitInversion } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalBitInversion(_e: BitInversion, _env: Env, _ctx: EvalContext): never {
  // JVM: no eval override (trees.scala:899-903), so `Value.eval` throws
  // (values.scala:101-102). Charge nothing, evaluate no operand: the JVM
  // throws before either.
  throw new EvalError('BitInversion has no JVM eval', 'unsupported-eval-node')
}
