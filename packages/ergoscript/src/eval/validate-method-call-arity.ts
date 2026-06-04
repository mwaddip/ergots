/**
 * Pre-eval, zero-cost, whole-tree pass: rejects a `MethodCall`-opcode node with
 * empty args in a V3+ tree — matching the JVM `MethodCallSerializer.parse`
 * `if (isV3OrLaterErgoTreeVersion) assert(args.nonEmpty)`
 * (data/shared/src/main/scala/sigma/serialization/MethodCallSerializer.scala:53-55).
 *
 * Honest trees never emit this: a zero-arg call serializes under the
 * PropertyCall opcode, not the MethodCall opcode. ergots' parser is deliberately
 * permissive (byte-roundtrip is load-bearing) and accepts an empty-args
 * MethodCall at every version, so any zero-arg method reached via the MethodCall
 * opcode — `none` 106:10, the pre-existing `groupGenerator` 106:1 — would
 * otherwise evaluate where the JVM rejects = a latent consensus fork. This pass
 * closes it.
 *
 * Wired into `dispatchTreeBody` on the post-substitution body (so substituted-in
 * Deserialize* subtrees are covered), before any cost — a rejected tree yields
 * no value and zero JIT cost, matching the JVM's deserialize-time rejection.
 * Method-agnostic (the JVM asserts before `SMethod.from_ids` — any
 * typeId/methodId). Pre-V3 is grandfathered (the JVM does NOT assert there, so
 * ergots must NOT reject pre-V3). `PropertyCall` nodes are exempt (the legit
 * zero-arg form). Mirrors eval/validate-bin-op-types.ts and
 * eval/validate-v6-types.ts.
 */
import type { Expr } from '../mir/types'
import { EvalError } from './eval-context'
import { childrenOf } from './_substitute-deserialize'

/**
 * Walk `body` and throw on the first empty-args MethodCall node, under
 * `treeVersion >= 3`. No-op for pre-V3 (grandfathered). Throws
 * `EvalError('method-call-empty-args')` without charging cost.
 */
export function validateMethodCallArity(body: Expr, treeVersion: number): void {
  if (treeVersion < 3) return // grandfathered: the JVM does not assert pre-V3
  walk(body)
}

function walk(e: Expr): void {
  if (e.tag === 'MethodCall' && e.args.length === 0) {
    throw new EvalError(
      `MethodCall (typeId=${e.typeId}, methodId=${e.methodId}) has empty args in a V3+ tree; ` +
        `empty-args calls must use the PropertyCall opcode`,
      'method-call-empty-args',
    )
  }
  for (const child of childrenOf(e)) walk(child)
}
