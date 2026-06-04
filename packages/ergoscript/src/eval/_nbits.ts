/**
 * Bitcoin-compact ("nBits") encoder — v6 P5b-2 (eval/_nbits.ts).
 *
 * Faithful port of JVM `NBitsUtils.encodeCompactBits`
 * (core/.../sigma/util/NBitsUtils.scala), cross-checked against
 * sigma-rust `ergo-node-integration` `encode_compact_bits`. Encodes a BigInt
 * into the Bitcoin "compact" 32-bit-ish form packed in a (signed) Long:
 *   N = (-1^sign) * mantissa * 256^(exponent-3).
 *
 * Crypto pins:
 *  - `size` = Java BigInteger.toByteArray().length (minimal two's-complement
 *    WITH sign byte) = encodeBigIntBE(value).length (0n -> [0x00], len 1).
 *  - longValue = low 64 bits, sign-extended = BigInt.asIntN(64, ·).
 *  - the 0x00800000 sign-bit carry (the escalation point).
 *  - NOT an inverse of decodeCompactBits for negative inputs.
 *  - `size <= 33` for any valid <=256-bit SBigInt input, so the `size << 24`
 *    overflow in the JVM cannot occur; no input range check here.
 */

import { encodeBigIntBE } from '../wire/serialize-svalue'

/** Scala `BigInt.longValue`: low 64 bits, sign-extended. */
function longValue(v: bigint): bigint {
  return BigInt.asIntN(64, v)
}

export function encodeCompactBits(value: bigint): bigint {
  const size0 = encodeBigIntBE(value).length
  let size = BigInt(size0)
  let result: bigint =
    size0 <= 3
      ? BigInt.asIntN(64, longValue(value) << BigInt(8 * (3 - size0)))
      : longValue(value >> BigInt(8 * (size0 - 3)))
  // sign-bit carry: if mantissa's top bit is set, shift down and bump exponent.
  if ((result & 0x00800000n) !== 0n) {
    result = BigInt.asIntN(64, result >> 8n)
    size += 1n
  }
  result = BigInt.asIntN(64, result | (size << 24n))
  if (value < 0n) result = BigInt.asIntN(64, result | 0x00800000n)
  return result
}
