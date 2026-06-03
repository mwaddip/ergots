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

/** Modular multiplicative inverse: the b ∈ [0, m) with a·b ≡ 1 (mod m).
 *  Hand-rolled classic iterative extended Euclidean (JS bigint has no native modInverse).
 *  Reuses umod twice: reduce the base into [0, m), then normalize the Bézout coefficient.
 *  Matches java.math.BigInteger.modInverse (CUnsignedBigInt.scala:57-59):
 *    - m === 0n   ⇒ arith-divide-by-zero (inherited from the first umod call below)
 *    - gcd(a,m)!=1 ⇒ unsigned-bigint-not-invertible (no multiplicative inverse)
 *    - m === 1n   ⇒ 0 (falls out: umod(a,1)=0, gcd=1, umod(0,1)=0 — no special case)
 *  Result ∈ [0, m) ⊂ [0, 2^256), so the UBI bound holds for free. Spec §4/§5. (P2d-2.) */
export function umodInverse(a: bigint, m: bigint): bigint {
  let oldR = umod(a, m) // reduce base into [0, m); throws arith-divide-by-zero on m === 0n
  let r = m
  let oldS = 1n
  let s = 0n
  while (r !== 0n) {
    const q = oldR / r // non-negative integer division (oldR, r >= 0 throughout)
    const newR = oldR - q * r
    oldR = r
    r = newR
    const newS = oldS - q * s
    oldS = s
    s = newS
  }
  // oldR = gcd(a, m); oldS is the Bézout coefficient of the reduced base
  if (oldR !== 1n) {
    throw new EvalError('UnsignedBigInt.modInverse: value not invertible (gcd != 1)', 'unsigned-bigint-not-invertible')
  }
  return umod(oldS, m) // normalize Bézout coefficient into [0, m)
}
