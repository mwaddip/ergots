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
 * serialization (body without tx_id + index). Used by `ExtractBytesWithNoRef`.
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

import type { ErgoBox, SType, SValue } from '../mir/types'
import { ByteWriter } from '@ergots/scorex'
import { writeBoxBodyWithoutRef, writeBoxRef } from './serialize-svalue'
import { isTypeWrittenAt, STypeSerializeError } from './serialize-stype'

/** Element types whose collection items hold no Box: the walk for a nested Box skips their items. */
const BOX_FREE_ELEMS: ReadonlySet<SType['tag']> = new Set([
  'SBoolean', 'SByte', 'SShort', 'SInt', 'SLong', 'SBigInt', 'SUnsignedBigInt', 'SGroupElement', 'SSigmaProp',
])

/**
 * Throws `STypeSerializeError('sfunc-tree-version-too-low')` when the JVM's type writer has no case, at
 * `treeVersion`, for the type of one of `box`'s R4-R9, or of one in a Box nested in a register's value
 * (through a collection's items, a tuple's items and an Option's value).
 */
function checkRegisterTypesWritten(box: ErgoBox, treeVersion: number): void {
  for (let k = 4; k <= 9; k++) {
    const entry = box.registers[k]
    if (entry === undefined) continue
    if (entry.tpe === undefined) {
      throw new TypeError(`R${k}: the register entry carries no type`)
    }
    if (!isTypeWrittenAt(entry.tpe, treeVersion)) {
      throw new STypeSerializeError(
        `R${k} has a type the writer has no case for at tree version ${treeVersion}`,
        'sfunc-tree-version-too-low'
      )
    }
    checkValueBoxesWritten(entry.value, treeVersion)
  }
}

function checkValueBoxesWritten(v: SValue, treeVersion: number): void {
  switch (v.kind) {
    case 'Box':
      checkRegisterTypesWritten(v.value, treeVersion)
      return
    case 'Coll':
      if (BOX_FREE_ELEMS.has(v.elem.tag)) return
      for (const item of v.items) checkValueBoxesWritten(item, treeVersion)
      return
    case 'Tuple':
      for (const item of v.items) checkValueBoxesWritten(item, treeVersion)
      return
    case 'Option':
      if (v.value !== null) checkValueBoxesWritten(v.value, treeVersion)
      return
    default:
      return
  }
}

/**
 * The JVM's write of a full box (`ErgoBox.sigmaSerializer`) inside a version context whose tree
 * version is `treeVersion`: a function type is written from tree version 3 only, so a register
 * whose type holds one (also in a Box nested in a register's value) throws
 * `STypeSerializeError('sfunc-tree-version-too-low')`. A register entry without its type, which only
 * a box built by hand can hold, is a `TypeError` naming the register. Outside any context the tree
 * version is 1.
 */
export function serializeBoxAtTreeVersion(box: ErgoBox, treeVersion: number): Uint8Array {
  checkRegisterTypesWritten(box, treeVersion)
  const w = new ByteWriter()
  writeBoxBodyWithoutRef(box, w, treeVersion)
  writeBoxRef(box, w)
  return w.toBytes()
}

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
 * Used by `ExtractBytesWithNoRef`.
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
