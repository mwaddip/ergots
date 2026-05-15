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
