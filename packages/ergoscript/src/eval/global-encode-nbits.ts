/**
 * SGlobal.encodeNbits (MethodCall, 106:6) — v6 P5b-2 eval handler.
 *
 * JVM: methods.scala:1939 — FixedCost(JitCost(25)); V3-gated; non-generic
 * (SGlobal, SBigInt) → SLong. Body: CSigmaDslBuilder.encodeNbits =
 * NBitsUtils.encodeCompactBits(bi). No reject path (valid <=256-bit SBigInt
 * input). Cost charged before the encode (cost-before-work pin).
 */

import { encodeCompactBits } from './_nbits'
import { EvalError, type EvalContext } from './eval-context'
import type { SValue } from '../mir/types'

const FAIL = 'global-encode-nbits-failed'

export function evalGlobalEncodeNbits(obj: SValue, args: SValue[], ctx: EvalContext): SValue {
  if (obj.kind !== 'Global') {
    throw new EvalError(`SGlobal.encodeNbits expects a Global obj; got '${obj.kind}'`, FAIL)
  }
  if (args.length !== 1) {
    throw new EvalError(`SGlobal.encodeNbits expects 1 arg; got ${args.length}`, FAIL)
  }
  const a = args[0]!
  if (a.kind !== 'BigInt') {
    throw new EvalError(`SGlobal.encodeNbits expects a BigInt arg; got '${a.kind}'`, FAIL)
  }
  ctx.addCost(25)
  return { kind: 'Long', value: encodeCompactBits(a.value) }
}
