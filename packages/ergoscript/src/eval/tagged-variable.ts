/**
 * TaggedVariable arm — unconditional eval-reject.
 *
 * The JVM 6.0.7 has NO eval for `TaggedVariableNode` (ast/values.scala:455-460).
 * The class inherits `Value.eval`'s default, which throws
 * (ast/values.scala:101-102). The companion `TaggedVariable.apply` is
 * `@deprecated` (ast/values.scala:474, "scheduled for retirement in v7.0"),
 * but the companion itself stays reachable so `TaggedVariableSerializer` can
 * look up its `opCode`: the node PARSES (the JVM keeps it in the serializer
 * dispatch table, `ValueSerializer.scala:97`).
 *
 * Cost: NOTHING is charged before the throw (there is no cost site to reach),
 * and the node has no operand to evaluate.
 */

import type { TaggedVariable } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalTaggedVariable(_e: TaggedVariable, _env: Env, _ctx: EvalContext): never {
  // JVM: no eval override (ast/values.scala:455-460), so `Value.eval` throws
  // (ast/values.scala:101-102). Charge nothing.
  throw new EvalError('TaggedVariable has no JVM eval', 'unsupported-eval-node')
}
