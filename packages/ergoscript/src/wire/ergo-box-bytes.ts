/**
 * Box canonical-bytes serializer. Mirrors sigma-rust's
 * `sigma_serialize for ErgoBox` (`chain/ergo_box.rs:201-223`) and the
 * `bytes_without_ref` variant (`chain/ergo_box.rs:195-198`).
 *
 * Wire layout:
 *   value           — VLQ u64 (BoxValue, unsigned — NOT ZigZag)
 *   ergo_tree_bytes — raw bytes written verbatim (self-delimiting via header)
 *   creation_height — VLQ u32 (sigma-ser `put_u32`)
 *   tokens_count    — raw u8 (NOT VLQ), max 122
 *   per-token       — 32-byte id (raw) + VLQ u64 amount
 *   additional_regs — raw u8 count + per-register: SType bytes + SValue bytes
 *   [full only] transaction_id — 32 raw bytes
 *   [full only] index          — VLQ u16 (sigma-ser `put_u16` = VLQ, NOT raw BE)
 *
 * `serializeBoxBytesWithoutRef` matches sigma-rust's `ErgoBoxCandidate`
 * serialization (body without tx_id + index). Used by `ExtractBytesWithNoRef`
 * (Task 7).
 *
 * Cross-reference: the `serialize-svalue.ts` SBox arm (`case 'SBox':`) shares
 * this implementation via `writeBoxBodyWithoutRef` to avoid byte-for-byte
 * duplication and drift risk.
 *
 * Sigma-rust refs:
 *   chain/ergo_box.rs:195-198   (bytes_without_ref)
 *   chain/ergo_box.rs:201-223   (sigma_serialize for ErgoBox)
 *   chain/ergo_box.rs:302-344   (serialize_box_with_indexed_digests)
 */

import type { ErgoBox } from '../mir/types'
import { ByteWriter } from './writer'
import { SValueSerializeError, writeBoxBodyWithoutRef } from './serialize-svalue'

/**
 * Serialize a full `ErgoBox` to bytes (with tx_id + index).
 *
 * Mirrors sigma-rust `ErgoBox::sigma_serialize_bytes()`.
 */
export function serializeBoxBytes(box: ErgoBox): Uint8Array {
  const w = new ByteWriter()
  writeBoxBodyWithoutRef(box, w)

  // transaction_id (32 raw bytes)
  if (box.txId.length !== 32) {
    throw new SValueSerializeError(
      `SBox txId length ${box.txId.length} must be 32`,
      'txid-length'
    )
  }
  w.writeBytes(box.txId)

  // index (VLQ u16 — sigma-ser `put_u16` = VLQ, NOT raw 2-byte BE)
  if (box.index < 0 || box.index > 0xffff) {
    throw new SValueSerializeError(
      `SBox index ${box.index} out of u16 range`,
      'sbox-index-out-of-range'
    )
  }
  w.writeVlqU(box.index)

  return w.toBytes()
}

/**
 * Serialize an `ErgoBox` without the transaction reference (no tx_id, no
 * index). Equivalent to sigma-rust's `ErgoBoxCandidate` serialization and
 * `ErgoBox::bytes_without_ref()`.
 *
 * Used by `ExtractBytesWithNoRef` (Task 7).
 */
export function serializeBoxBytesWithoutRef(box: ErgoBox): Uint8Array {
  const w = new ByteWriter()
  writeBoxBodyWithoutRef(box, w)
  return w.toBytes()
}
