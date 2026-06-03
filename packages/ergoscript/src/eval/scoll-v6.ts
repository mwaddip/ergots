/**
 * v6 (ErgoTree V3) SCollection method handlers — phase v6 P3.
 *
 * reverse (30), startsWith (31), endsWith (32), get (33). Registered with
 * minVersion:3 in eval/method-call.ts. obj + args arrive pre-evaluated from the
 * dispatcher. Defensive receiver/arg-kind checks reuse 'method-not-implemented'
 * (the SColl MethodCall convention — see method-call.ts zip/patch).
 *
 * JVM source: sigma/ast/methods.scala SCollectionMethods (v6Methods, :1211-1216).
 */
import type { SValue } from '../mir/types'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

// reverse (12:30) — Append.costKind PerItemCost(20,2,100) on receiver length.
// JVM: methods.scala:1126-1141. tRange Coll[IV] (generic; resolved by P0).
export function evalCollReverse(obj: SValue, _args: SValue[], ctx: EvalContext): SValue {
  if (obj.kind !== 'Coll') {
    throw new EvalError(`SColl.reverse expects a Coll obj; got '${obj.kind}'`, 'method-not-implemented')
  }
  ctx.addPerItemCost(20, 2, 100, obj.items.length) // Append.costKind; methods.scala:1124
  return { kind: 'Coll', elem: obj.elem, items: [...obj.items].reverse() }
}

// get (12:33) — ByIndex.costKind FixedCost(30). Total: 0<=i<len ? Some : None.
// JVM: methods.scala:1183-1189 (.withIRInfo(MethodCallIrBuilder) → stays a MethodCall).
// tRange Option[IV] (generic; resolved by P0).
export function evalCollGet(obj: SValue, args: SValue[], ctx: EvalContext): SValue {
  if (obj.kind !== 'Coll') {
    throw new EvalError(`SColl.get expects a Coll obj; got '${obj.kind}'`, 'method-not-implemented')
  }
  ctx.addCost(30) // ByIndex.costKind FixedCost(30); transformers.scala:285
  const idx = args[0]
  if (args.length !== 1 || idx === undefined || idx.kind !== 'Int') {
    throw new EvalError(`SColl.get expects 1 Int arg; got ${args.map((a) => a.kind).join(',')}`, 'method-not-implemented')
  }
  const i = idx.value
  const inBounds = i >= 0 && i < obj.items.length
  return { kind: 'Option', elem: obj.elem, value: inBounds ? obj.items[i]! : null }
}
