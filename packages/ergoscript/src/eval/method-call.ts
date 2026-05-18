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
 * Error codes originated here:
 *   'method-not-implemented'    — dispatcher hit a (typeId, methodId) not in the registry;
 *                                  also reused for defensive shape mismatches in registered handlers.
 *   'context-obj-not-context'   — thrown by the SContext.dataInputs handler when obj is not Context.
 *
 * Codes callers may also observe (owned by other modules):
 *   'cost-limit-exceeded'       — thrown by ctx.addCost() in eval-context.ts when jitCostLimit is reached.
 */

import type { ErgoBox, MethodCall, PropertyCall, SType, SValue } from '../mir/types'
import { GROUP_GENERATOR_BYTES } from './_group-generator'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue } from './_byte-coll'
import { SCOLL_BYTE } from './_box-synthesis'
import { primitiveValueEqual } from './bin-op/relation'

// Module-level SType singletons used in handler helpers.
// Coll[STuple[SColl[Byte], Long]] — return type for tokensCollOf.
// SBox — element type for dataInputsCollOf.
const SLONG: SType = { tag: 'SLong' }
const STUPLE_COLLBYTE_LONG: SType = { tag: 'STuple', items: [SCOLL_BYTE, SLONG] }
const SBOX: SType = { tag: 'SBox' }

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
  // SBox.tokens (PropertyCall, typeId=99, methodId=8)
  // Source: ergotree-interpreter/src/eval/sbox.rs:72-79 — TOKENS_EVAL_FN
  // Cost 15 (Pattern A within handler). Returns Coll[(Coll[Byte], Long)].
  HANDLERS.set(handlerKey(99, 8), (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(15)
    if (obj.kind !== 'Box') {
      throw new EvalError(
        `SBox.tokens expects a Box obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1 (spec: error-taxonomy decision)
      )
    }
    return tokensCollOf(obj.value)
  })

  // SContext.dataInputs (PropertyCall, typeId=101, methodId=1)
  // Source: ergotree-interpreter/src/eval/scontext.rs:17-31 — DATA_INPUTS_EVAL_FN
  // Cost 15 (Pattern A within handler). Returns Coll[Box] from ctx.dataInputs ?? [].
  HANDLERS.set(handlerKey(101, 1), (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(15)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.dataInputs expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context'
      )
    }
    return dataInputsCollOf(ctx.dataInputs ?? [])
  })

  // SColl.indexOf (MethodCall, typeId=12, methodId=26)
  // Source: ergotree-interpreter/src/eval/scoll.rs:21-50 — INDEX_OF_EVAL_FN
  // Pattern B cost: addPerItemCost(20, 10, 2, n) AFTER extracting Coll, BEFORE search.
  // 'from < 0' clamped to 0. Returns Int index or -1.
  HANDLERS.set(handlerKey(12, 26), (obj, args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.indexOf expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy (option 1)
      )
    }
    const n = obj.items.length
    ctx.addPerItemCost(20, 10, 2, n) // Pattern B; source: scoll.rs:31
    if (args.length !== 2) {
      throw new EvalError(
        `SColl.indexOf expects 2 args; got ${args.length}`,
        'method-not-implemented'
      )
    }
    const [target, fromArg] = args as [SValue, SValue]
    if (fromArg.kind !== 'Int') {
      throw new EvalError(
        `SColl.indexOf expects 'from' to be Int; got '${fromArg.kind}'`,
        'method-not-implemented'
      )
    }
    const from = Math.max(0, fromArg.value)
    for (let i = from; i < n; i++) {
      if (primitiveValueEqual(obj.items[i]!, target)) return { kind: 'Int', value: i }
    }
    return { kind: 'Int', value: -1 }
  })

  // SGlobal.groupGenerator (PropertyCall, typeId=106, methodId=1)
  // Source: ergotree-interpreter/src/eval/sglobal.rs:32-41 — GROUP_GENERATOR_EVAL_FN
  // Pattern A cost 10 (charged before obj check). Returns 33-byte SEC1 of secp256k1 base point.
  HANDLERS.set(handlerKey(106, 1), (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(10)
    if (obj.kind !== 'Global') {
      throw new EvalError(
        `SGlobal.groupGenerator expects a Global obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return { kind: 'GroupElement', value: GROUP_GENERATOR_BYTES }
  })
}

registerHandlers()

// ---------- SBox.tokens helper ----------

/** Convert ErgoBox.tokens to a Coll[(Coll[Byte], Long)] SValue. */
function tokensCollOf(box: ErgoBox): SValue {
  return {
    kind: 'Coll',
    elem: STUPLE_COLLBYTE_LONG,
    items: box.tokens.map((t) => ({
      kind: 'Tuple',
      items: [bytesToCollByteSValue(t.id), { kind: 'Long', value: t.amount }],
    })),
  }
}

// ---------- SContext.dataInputs helper ----------

/** Convert an ErgoBox[] to a Coll[Box] SValue. */
function dataInputsCollOf(boxes: ErgoBox[]): SValue {
  return {
    kind: 'Coll',
    elem: SBOX,
    items: boxes.map((b) => ({ kind: 'Box', value: b })),
  }
}
