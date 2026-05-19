/**
 * Box-field synthesis helpers — SValue constructors derived from `ErgoBox` fields.
 *
 * These are used by multiple Box-extract eval arms that need to synthesize
 * register values from box fields:
 *
 *   - `creationInfoTupleSValue` — used by ExtractCreationInfo (Task 5) AND
 *     ExtractRegisterAs (Task 4, R3 synthesis). Promoted here from Task 4's
 *     local function to avoid duplication and drift.
 *
 * Sigma-rust reference: `ergotree-ir/src/chain/ergo_box.rs:185-192`
 *   ```
 *   pub fn creation_info(&self) -> (i32, Vec<i8>) {
 *       let mut bytes = Vec::with_capacity(Digest32::SIZE + 2);
 *       bytes.extend_from_slice(self.transaction_id.0 .0.as_ref());
 *       bytes.extend_from_slice(&self.index.to_be_bytes());
 *       (self.creation_height as i32, bytes.as_vec_i8())
 *   }
 *   ```
 * Digest32::SIZE = 32, so `bytes` is exactly 34 bytes: 32-byte txId + 2-byte BE u16 index.
 *
 * Note: underscore prefix on filename (`_box-synthesis.ts`) follows the
 * existing `_numeric.ts` / `_byte-coll.ts` convention for internal eval helpers.
 */

import type { ErgoBox, SType, SValue } from '../mir/types'
import { bytesToCollByteSValue } from './_byte-coll'

// Shared SType singletons for R3 / ExtractCreationInfo return type.
// STuple[SInt, SColl[SByte]] matches sigma-rust's `ExtractCreationInfo::tpe()`:
//   SType::STuple(STuple::pair(SType::SInt, SType::SColl(SType::SByte.into())))
const SINT: SType = { tag: 'SInt' }
const SBYTE: SType = { tag: 'SByte' }
const SCOLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }

/**
 * Build an SValue for R3 / ExtractCreationInfo: STuple[SInt, SColl[SByte]] from box creation info.
 *
 * Mirrors sigma-rust `ergo_box.rs:185-192` `creation_info()`:
 *   (self.creation_height as i32, bytes)
 * where bytes = txId (32 bytes) ++ index as BE u16 (2 bytes) = 34 bytes total.
 *
 * The TS `ErgoBox.index` is a number (u16) and `txId` is a Uint8Array (32 bytes).
 *
 * Used by:
 *   - `extract-register-as.ts` (R3 synthesis in `getRegisterEntry`)
 *   - `extract-creation-info.ts` (direct return value)
 */
export function creationInfoTupleSValue(box: ErgoBox): SValue {
  const combined = new Uint8Array(34)
  combined.set(box.txId, 0)
  combined[32] = (box.index >> 8) & 0xff
  combined[33] = box.index & 0xff
  // Audit ERG-08: sigma-rust does `self.creation_height as i32`
  // (eval/extract_creation_info.rs:18). Mirror the i32 wrap so JS Numbers
  // outside i32 range produce the same SValue.Int the sigma-rust evaluator
  // would.
  return {
    kind: 'Tuple',
    items: [
      { kind: 'Int', value: box.creationHeight | 0 },
      bytesToCollByteSValue(combined),
    ],
  }
}

// Export SCOLL_BYTE for any caller that needs the R3 SType (e.g. extract-register-as.ts).
// This avoids duplicating the SType singleton definition in both arm files.
export { SINT, SCOLL_BYTE }
