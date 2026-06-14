/**
 * SGlobal.powHit (MethodCall, 106:8) — v6 P5c eval handler.
 *
 * JVM methods.scala:1884-1902 — FixedCost(PowHitCostKind.cost), V3-gated;
 * SFunc([SGlobal, SInt, Coll[Byte], Coll[Byte], Coll[Byte], SInt] -> SUnsignedBigInt).
 * Body = CSigmaDslBuilder.powHit -> Autolykos2PowValidation.hitForVersion2ForMessageWithChecks
 * (the @ergots/scorex hit core).
 *
 * Pins:
 *  - Cost c = 500 + (k+1)*(trunc(L/128)+1)*7 (L = total arg-byte length; reuses
 *    CalcBlake2b256 chunkSize=128/perChunk=7). Bespoke formula, NOT (n-1)/cs+1.
 *  - Charged from RAW k BEFORE the require guards (cost-then-throw).
 *  - Guards (k>=2,k<=32,N>=16) live in scorex's WithChecks; mapped to
 *    'pow-hit-invalid-params' here (mirrors checkPow's v1 mapping).
 *  - hit = blake2b256(...) is always < 2^256 -> valid UBI.
 *
 * Source Mapping:
 *   JVM: sigma/ast/methods.scala:1884-1902 (PowHitCostKind, hitForVersion2ForMessageWithChecks)
 *   sigma-rust: evaluation is not yet implemented upstream; cost model from JVM only.
 *   ergots scorex: packages/scorex/src/autolykos-v2.ts:266+ (autolykosHitForMessageWithChecks)
 */

import { autolykosHitForMessageWithChecks, PowHitInvalidParamsError } from '@ergots/scorex'
import { collByteToUint8Array } from './_byte-coll'
import { EvalError, type EvalContext } from './eval-context'
import type { SValue } from '../mir/types'

const FAIL = 'pow-hit-invalid-params'
const CHUNK_SIZE = 128
const PER_CHUNK = 7
const BASE_COST = 500

export function evalGlobalPowHit(obj: SValue, args: SValue[], ctx: EvalContext): SValue {
  if (obj.kind !== 'Global') {
    throw new EvalError(`SGlobal.powHit expects a Global obj; got '${obj.kind}'`, FAIL)
  }
  if (args.length !== 5) {
    throw new EvalError(`SGlobal.powHit expects 5 args; got ${args.length}`, FAIL)
  }
  const kArg = args[0]!
  const nArg = args[4]!
  if (kArg.kind !== 'Int') {
    throw new EvalError(`SGlobal.powHit expects an Int k; got '${kArg.kind}'`, FAIL)
  }
  if (nArg.kind !== 'Int') {
    throw new EvalError(`SGlobal.powHit expects an Int N; got '${nArg.kind}'`, FAIL)
  }
  const k = kArg.value
  const N = nArg.value
  const msg = collByteToUint8Array(args[1]!, 'Global.powHit msg')
  const nonce = collByteToUint8Array(args[2]!, 'Global.powHit nonce')
  const h = collByteToUint8Array(args[3]!, 'Global.powHit h')

  // Bespoke cost formula (JVM CostKind.scala:79-87, PowHitCostKind):
  //   c = 500 + (k+1) * (trunc(L/128)+1) * 7
  // Charged from RAW k BEFORE the guards (cost-then-throw).
  const L = msg.length + nonce.length + h.length
  const c = BASE_COST + (k + 1) * (Math.trunc(L / CHUNK_SIZE) + 1) * PER_CHUNK
  ctx.addCost(c)

  try {
    const hit = autolykosHitForMessageWithChecks(k, msg, nonce, h, N)
    return { kind: 'UnsignedBigInt', value: hit }
  } catch (e) {
    if (e instanceof PowHitInvalidParamsError) {
      throw new EvalError(e.message, FAIL)
    }
    throw e
  }
}
