/**
 * SGlobal.decodeNbits (MethodCall, 106:7) — v6 P5b-2 eval handler.
 *
 * JVM: methods.scala:1944 — FixedCost(JitCost(50)); V3-gated; non-generic
 * (SGlobal, SLong) → SBigInt. Body: CSigmaDslBuilder.decodeNbits =
 * CBigInt(NBitsUtils.decodeCompactBits(l).bigInteger.toSignedBigIntValueExact).
 *
 * Reuses the tested @ergots/scorex `decodeCompactBits` (proven byte-equal to
 * NBitsUtils.decodeCompactBits). Two adapters: (1) the JVM reads only the low
 * 32 bits of the Long (sigma-rust `nbits as u32`); (2) the result is
 * range-checked to signed-256 (toSignedBigIntValueExact = bitLength <= 255 =
 * [I256_MIN, I256_MAX]) and rejects on overflow. Cost charged before decode.
 */

import { decodeCompactBits } from '@ergots/scorex'
import { I256_MIN, I256_MAX } from './_byte-coll'
import { EvalError, type EvalContext } from './eval-context'
import type { SValue } from '../mir/types'

const FAIL = 'global-decode-nbits-failed'

export function evalGlobalDecodeNbits(obj: SValue, args: SValue[], ctx: EvalContext): SValue {
  if (obj.kind !== 'Global') {
    throw new EvalError(`SGlobal.decodeNbits expects a Global obj; got '${obj.kind}'`, FAIL)
  }
  if (args.length !== 1) {
    throw new EvalError(`SGlobal.decodeNbits expects 1 arg; got ${args.length}`, FAIL)
  }
  const a = args[0]!
  if (a.kind !== 'Long') {
    throw new EvalError(`SGlobal.decodeNbits expects a Long arg; got '${a.kind}'`, FAIL)
  }
  ctx.addCost(50)
  // JVM reads only the low 32 bits of the Long (NBitsUtils.decodeCompactBits;
  // sigma-rust `nbits as u32`).
  const decoded = decodeCompactBits(Number(BigInt.asUintN(32, a.value)))
  // CSigmaDslBuilder.decodeNbits: toSignedBigIntValueExact -> reject if bitLength > 255.
  if (decoded < I256_MIN || decoded > I256_MAX) {
    throw new EvalError(`decodeNbits result out of signed-256 range`, FAIL)
  }
  return { kind: 'BigInt', value: decoded }
}
