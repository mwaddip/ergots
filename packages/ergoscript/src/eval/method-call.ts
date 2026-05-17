/**
 * `MethodCall` + `PropertyCall` dispatcher — routes to per-method handlers
 * via a (typeId, methodId) registry.
 *
 * Pattern A: cost 4 charged BEFORE eval-children. Source: method_call.rs:17,
 * property_call.rs:16.
 *
 * The registry is module-internal. Tasks 4-6 register handlers below the
 * dispatcher definition (in this same file) — keeping co-location simple
 * while the registry has only 3 entries. Promote to a subdirectory when
 * count grows.
 *
 * Error codes:
 *   'method-not-implemented'    — dispatcher hit a (typeId, methodId) not in the registry;
 *                                  also reused for defensive shape mismatches in registered handlers.
 *   'context-obj-not-context'   — SContext.dataInputs got a non-Context obj (Task 5).
 *   'cost-limit-exceeded'       — cost exceeds jitCostLimit.
 */

import type { MethodCall, PropertyCall, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

type MethodHandler = (
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>
) => SValue

function handlerKey(typeId: number, methodId: number): string {
  return `${typeId}:${methodId}`
}

const HANDLERS = new Map<string, MethodHandler>()

export function evalMethodCall(e: MethodCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4) // Pattern A; source: method_call.rs:17
  const obj = evalExpr(e.obj, env, ctx)
  const args = e.args.map((a) => evalExpr(a, env, ctx))
  return dispatch(e.typeId, e.methodId, obj, args, ctx, e.explicitTypeArgs)
}

export function evalPropertyCall(e: PropertyCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4) // Pattern A; source: property_call.rs:16
  const obj = evalExpr(e.obj, env, ctx)
  return dispatch(e.typeId, e.methodId, obj, [], ctx, {})
}

function dispatch(
  typeId: number,
  methodId: number,
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>
): SValue {
  const handler = HANDLERS.get(handlerKey(typeId, methodId))
  if (!handler) {
    throw new EvalError(
      `method not implemented: typeId=${typeId}, methodId=${methodId}`,
      'method-not-implemented'
    )
  }
  return handler(obj, args, ctx, explicitTypeArgs)
}

// ---------- Handler registration ----------

function registerHandlers(): void {
  // Tasks 4-6 add registrations here.
}

registerHandlers()
