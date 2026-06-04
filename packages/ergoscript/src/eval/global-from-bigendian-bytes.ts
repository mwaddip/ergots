/**
 * SGlobal.fromBigEndianBytes[T] (MethodCall, 106:5) — v6 P5b-1 eval handler.
 *
 * JVM: methods.scala:1925-1932 — FixedCost(JitCost(10)); V3-gated; generic over
 * the six numeric types. Decodes a big-endian byte Coll into a value of the
 * wire-specified type T. Inverse of P1 `toBytes` (eval/_numeric-v6.ts).
 * Semantics: CSigmaDslBuilder.fromBigEndianBytes (:225-261).
 *
 * Faithfulness pins:
 *  - FixedCost(10) charged BEFORE per-type validation/decode (even on failure),
 *    mirroring deserializeTo's cost-before-work and the JVM method-dispatch order.
 *  - Non-numeric T rejected at EVAL (the default branch), not at deserialize — the
 *    JVM's unsupported-type throw is in the runtime body, so an adversarial
 *    fromBigEndianBytes[Boolean] tree deserializes fine and fails here.
 *  - BigInt: reject empty (JVM `new BigInteger(byte[0])` throws) and len>32; a
 *    <=32-byte two's-complement value always fits signed-256, so no extra range check.
 *  - UBI: empty -> 0 (matches BigIntegers.fromUnsignedByteArray([])); reject len>32.
 */

import { collByteToUint8Array } from './_byte-coll'
import { EvalError, type EvalContext } from './eval-context'
import type { SType, SValue } from '../mir/types'

const FAIL = 'global-from-bigendian-bytes-failed'

export function evalGlobalFromBigEndianBytes(
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>,
): SValue {
  if (obj.kind !== 'Global') {
    throw new EvalError(`SGlobal.fromBigEndianBytes expects a Global obj; got '${obj.kind}'`, FAIL)
  }
  if (args.length !== 1) {
    throw new EvalError(`SGlobal.fromBigEndianBytes expects 1 arg; got ${args.length}`, FAIL)
  }

  // Arg-shape extraction mirrors deserializeTo (default 'predef-input-not-byte-array'
  // code; type system guarantees Coll[Byte] for well-typed trees).
  const bytes = collByteToUint8Array(args[0]!, 'Global.fromBigEndianBytes')

  // FixedCost(10) — before validation/decode, even on subsequent failure.
  ctx.addCost(10)

  const T = explicitTypeArgs['T']!
  switch (T.tag) {
    case 'SByte': {
      if (bytes.length !== 1) {
        throw new EvalError(`fromBigEndianBytes[Byte] needs exactly 1 byte, got ${bytes.length}`, FAIL)
      }
      return { kind: 'Byte', value: (bytes[0]! << 24) >> 24 }
    }
    case 'SShort': {
      if (bytes.length !== 2) {
        throw new EvalError(`fromBigEndianBytes[Short] needs exactly 2 bytes, got ${bytes.length}`, FAIL)
      }
      return { kind: 'Short', value: (((bytes[0]! << 8) | bytes[1]!) << 16) >> 16 }
    }
    case 'SInt': {
      if (bytes.length !== 4) {
        throw new EvalError(`fromBigEndianBytes[Int] needs exactly 4 bytes, got ${bytes.length}`, FAIL)
      }
      return {
        kind: 'Int',
        value: ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) | 0,
      }
    }
    case 'SLong': {
      if (bytes.length !== 8) {
        throw new EvalError(`fromBigEndianBytes[Long] needs exactly 8 bytes, got ${bytes.length}`, FAIL)
      }
      let v = 0n
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[i]!)
      return { kind: 'Long', value: BigInt.asIntN(64, v) }
    }
    default:
      throw new EvalError(`fromBigEndianBytes: unsupported type '${T.tag}'`, FAIL)
  }
}
