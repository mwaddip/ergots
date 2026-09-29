/**
 * Box canonical-bytes serializer. Mirrors sigma-rust's
 * `sigma_serialize for ErgoBox` (`chain/ergo_box.rs:201-223`) and the
 * `bytes_without_ref` variant (`chain/ergo_box.rs:195-198`).
 *
 * Wire layout:
 *   value           — VLQ u64 (BoxValue, unsigned — NOT ZigZag)
 *   ergo_tree       — the tree re-encoded, `reencodeTreeBytes(box.ergoTreeBytes)`, as the
 *                     JVM writes `serializeErgoTree(box.ergoTree)` (ErgoBoxCandidate.scala:142)
 *   creation_height — VLQ u32 (sigma-ser `put_u32`)
 *   tokens_count    — raw u8 (NOT VLQ), max 255 (the u8 wire ceiling; JVM
 *                     putUByte 0..255 assert, ErgoBoxCandidate.scala:144)
 *   per-token       — 32-byte id (raw) + VLQ u64 amount
 *   additional_regs — raw u8 count + per-register: SType bytes + SValue bytes
 *   [full only] transaction_id — 32 raw bytes
 *   [full only] index          — VLQ, the JVM's putUShort of a Short: [0, 0x7FFF]
 *                                (`writeBoxRef`, serialize-svalue.ts)
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
import { ByteWriter } from '@ergots/scorex'
import { writeBoxBodyWithoutRef, writeBoxRef } from './serialize-svalue'

/**
 * Serialize a full `ErgoBox` to bytes (with tx_id + index).
 *
 * Mirrors sigma-rust `ErgoBox::sigma_serialize_bytes()`.
 */
export function serializeBoxBytes(box: ErgoBox): Uint8Array {
  const w = new ByteWriter()
  // Standalone box-bytes serialization pins version 0 deliberately: the JVM
  // prevents version-gated DATA (Option/SHeader/SUnsignedBigInt) from ever
  // ENTERING box registers via rule 1019 CheckV6Type (ErgoBoxCandidate.scala:232)
  // — ergots' rule-1019 mirror is in effect (commit d9cb19e, 'register-v6-type'
  // at register ingress), so v6-typed register values are rejected at parse time
  // and this pinned-v0 path is unreachable from well-formed input.
  writeBoxBodyWithoutRef(box, w, 0)
  writeBoxRef(box, w)
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
  // Standalone box-bytes serialization pins version 0 deliberately: the JVM
  // prevents version-gated DATA (Option/SHeader/SUnsignedBigInt) from ever
  // ENTERING box registers via rule 1019 CheckV6Type (ErgoBoxCandidate.scala:232)
  // — ergots' rule-1019 mirror is in effect (commit d9cb19e, 'register-v6-type'
  // at register ingress), so v6-typed register values are rejected at parse time
  // and this pinned-v0 path is unreachable from well-formed input.
  writeBoxBodyWithoutRef(box, w, 0)
  return w.toBytes()
}
