/**
 * UBI cast matrix — mirrors JVM `<target>.upcast/downcast(<source>)`
 * (sigma SType.scala:419-590). Isolated from the shared numeric helpers so
 * the shared `isNumeric`/`NumericKind`/`bigIntToValue` stay v5-only (widening
 * them would make Negation/arith/ordering accept UBI = a fork). UBI value is
 * a non-negative magnitude bigint; we read `.value` directly (valueToBigInt /
 * bigIntToValue have no UBI arm and would throw on a UBI kind).
 *
 * Matrix (verified against SType.scala SUnsignedBigInt/SBigInt/SLong/.. case
 * objects, lines 419-590):
 *   target = UBI:  Byte/Short/Int/Long -> CUnsignedBigInt iff >= 0 (else
 *                  `sys.error("negative value")`); UnsignedBigInt -> identity
 *                  (always >= 0); NO BigInt case -> reject (use toUnsigned).
 *                  Cost 30 (NumericCastCostKind: SUnsignedBigInt -> JitCost(30)).
 *   source = UBI, target signed: `SByte/SShort/SInt/SLong.downcast` each carry
 *                  `case ubi: UnsignedBigInt if isV3OrLater => ubi.toXExact`
 *                  -> range-checked produce. Their `.upcast` carry NO ubi case
 *                  -> reject.
 *   source = UBI, target SBigInt: `SBigInt.up/downcast` carry NO ubi case
 *                  -> reject (use toSigned).
 *
 * No V3 gate inside the branch: a cast with `tpe = SUnsignedBigInt` (type code
 * 9) is rejected pre-eval by validateV6Types in `< V3` trees, and a UBI source
 * value only exists in V3+ trees (the JVM's `if isV3OrLater` guard on the ubi
 * downcast cases is therefore already satisfied whenever this code runs).
 */
import type { SType, SValue } from '../mir/types'
import { EvalError } from './eval-context'
import { bigIntToValue, checkRange, type NumericKind } from './bin-op/_numeric'
import { UBI_OUT_OF_RANGE } from './_numeric-v6'

const SIGNED_KIND: Record<string, NumericKind> = {
  SByte: 'Byte',
  SShort: 'Short',
  SInt: 'Int',
  SLong: 'Long',
}

/** Produce a UBI from a source value (target = SUnsignedBigInt). Mirrors
 *  SUnsignedBigInt.upcast/downcast: Byte/Short/Int/Long/UBI -> CUnsignedBigInt
 *  (reject < 0); no BigInt case (use toUnsigned). */
export function castToUBI(input: SValue): SValue {
  if (input.kind === 'UnsignedBigInt') return input               // identity (value >= 0)
  let v: bigint
  switch (input.kind) {
    case 'Byte': case 'Short': case 'Int': v = BigInt(input.value); break
    case 'Long': v = input.value; break
    case 'BigInt':
      throw new EvalError('cast BigInt -> UnsignedBigInt is not supported; use toUnsigned', 'unsigned-bigint-op-unsupported')
    default:
      throw new EvalError(`cast to UnsignedBigInt: operand kind must be numeric, got '${input.kind}'`, 'bin-op-not-numeric')
  }
  if (v < 0n) throw new EvalError(`cast to UnsignedBigInt: negative value ${v}`, UBI_OUT_OF_RANGE)
  return { kind: 'UnsignedBigInt', value: v }
}

/** Downcast where source or target is UBI. Mirrors `<tpe>.downcast(source)`. */
export function downcastUBI(input: SValue, tpe: SType): SValue {
  if (tpe.tag === 'SUnsignedBigInt') return castToUBI(input)       // target = UBI
  // here: source is UBI (branch precondition), target signed or BigInt
  const v = (input as { value: bigint }).value
  if (tpe.tag === 'SBigInt') {
    throw new EvalError('Downcast UnsignedBigInt -> BigInt is not supported; use toSigned', 'unsigned-bigint-op-unsupported')
  }
  const kind = SIGNED_KIND[tpe.tag]
  if (kind === undefined) throw new EvalError(`Downcast UnsignedBigInt -> ${tpe.tag} is not numeric`, 'bin-op-not-numeric')
  checkRange(v, kind, 'downcast-overflow')
  return bigIntToValue(kind, v)
}

/** Upcast where source or target is UBI. Mirrors `<tpe>.upcast(source)`. */
export function upcastUBI(input: SValue, tpe: SType): SValue {
  if (tpe.tag === 'SUnsignedBigInt') return castToUBI(input)       // target = UBI
  // source is UBI, target signed/BigInt: those `.upcast` have no UBI case
  throw new EvalError(`Upcast UnsignedBigInt -> ${tpe.tag} is not supported`, 'unsigned-bigint-op-unsupported')
}
