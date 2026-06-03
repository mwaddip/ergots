/**
 * UnsignedBigInt (UBI) modular-arithmetic primitive — phase v6 P2d-1.
 *
 * The single Euclidean-modulo chokepoint shared by mod/plusMod/subtractMod/
 * multiplyMod (eval/method-call.ts, typeId 9) and BigInt.toUnsignedMod (typeId 6).
 * JS `%` is a remainder (sign follows the dividend); java.math.BigInteger.mod
 * always returns the non-negative residue in [0, m). `((x % m) + m) % m` recovers
 * it — load-bearing for subtractMod underflow and toUnsignedMod's signed receiver.
 *
 * Canonical: CUnsignedBigInt.{mod,plusMod,subtractMod,multiplyMod} (CUnsignedBigInt.scala:47-77)
 * + CBigInt.toUnsignedMod (CBigInt.scala:77-79), all java.math.BigInteger.mod. m==0 ⇒ JVM throws
 * ArithmeticException("BigInteger: modulus not positive"); a UBI is always ≥ 0, so m ≤ 0 ⟺ m == 0.
 * Result is always ∈ [0, m) ⊂ [0, 2²⁵⁶), so the CUnsignedBigInt bound is satisfied for free.
 * Spec §4/§5. (modInverse is P2d-2.)
 */
import { EvalError } from './eval-context'

/** Euclidean modulo: residue in [0, m). Throws on m === 0n (caller surfaces as arith-divide-by-zero). */
export function umod(x: bigint, m: bigint): bigint {
  if (m === 0n) {
    throw new EvalError('UnsignedBigInt modular op: modulus is zero', 'arith-divide-by-zero')
  }
  return ((x % m) + m) % m
}
