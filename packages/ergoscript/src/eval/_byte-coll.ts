/**
 * `bytesToCollByteSValue` — wrap a `Uint8Array` as a `Coll[Byte]` SValue.
 *
 * Each byte is sign-extended from u8 to signed-i8 (range -128..=127),
 * matching the parser's `SByte` convention at `wire/parse-svalue.ts:96-97`.
 *
 * Used by phase 2f Stop α/β/γ Box-extract arms (ExtractScriptBytes,
 * ExtractCreationInfo, ExtractBytes, ExtractBytesWithNoRef, ExtractId).
 * Promote-on-third-caller threshold met: 5 of 7 Box-extract arms call
 * this helper, so the shared file is justified per slice-B/2e YAGNI
 * precedent.
 *
 * Note: the underscore prefix on the filename (`_byte-coll.ts`) follows
 * the existing `_numeric.ts` convention for internal eval helpers.
 */

import type { SType, SValue } from '../mir/types'

const SBYTE_TYPE: SType = { tag: 'SByte' }

export function bytesToCollByteSValue(bytes: Uint8Array): SValue {
  const items: SValue[] = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    // Sign-extend u8 → signed i32 in JS — matches parser convention.
    items[i] = { kind: 'Byte', value: (bytes[i]! << 24) >> 24 }
  }
  return { kind: 'Coll', elem: SBYTE_TYPE, items }
}

/**
 * Signed big-endian byte-array -> bigint. Pure bigint arithmetic; no
 * `@noble/curves` or other crypto dependency.
 *
 * Empty input is REJECTED by the caller (this helper assumes
 * `bytes.length >= 1`). The high bit of `bytes[0]` is the sign bit (matches
 * sigma-rust's interpretation of the i8 sign byte in
 * `bnum::I256::from_be_slice` at `bnum-0.12.1/src/bint/endian.rs:64-109`).
 *
 * Used by: ByteArrayToBigInt (T6, phase 2i-a). Separate from
 * `bytesToCollByteSValue` because that helper goes Uint8Array → SValue, while
 * this one goes Uint8Array → bigint scalar.
 */
export function signedBeBytesToBigInt(bytes: Uint8Array): bigint {
  // Accumulate unsigned BE first.
  let value = 0n
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) | BigInt(bytes[i]!)
  }
  // Sign-extend if the high bit of the first byte is set: convert from
  // unsigned-BE (0..2^N - 1) to signed-BE (-2^(N-1)..2^(N-1) - 1).
  if (bytes[0]! & 0x80) {
    value -= 1n << BigInt(bytes.length * 8)
  }
  return value
}

/** Signed 256-bit integer minimum: -2^255. Used by ByteArrayToBigInt range check. */
export const I256_MIN = -(1n << 255n)

/** Signed 256-bit integer maximum: 2^255 - 1. Used by ByteArrayToBigInt range check. */
export const I256_MAX = (1n << 255n) - 1n
