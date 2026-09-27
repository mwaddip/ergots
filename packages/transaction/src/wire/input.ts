/**
 * Input + SpendingProof + ContextExtension wire codec.
 *
 * Source mapping:
 *   sigma-rust ergotree-ir/src/chain/transaction/input.rs    — Input, ProverResult
 *   sigma-rust ergotree-ir/src/chain/context_extension.rs    — ContextExtension
 *   JVM sigma-state v6.0.6 data/shared/src/main/scala/sigma/interpreter/
 *     ContextExtension.scala:44-66                           — count and id bounds
 *
 * Wire layout (sigma-rust `sigma_serialize`):
 *   boxId:           32 bytes (no length prefix)
 *   proofBytes:      VLQ-u32 length, then that many bytes
 *   contextExtension count: 1 byte, < 0x80 (not a VLQ), then each entry:
 *                      varId:  1 byte, < 0x80
 *                      tpe:    SType wire encoding
 *                      value:  SValue wire encoding
 *
 * Byte-identity strategy: re-serialize the decoded entries in their RECEIVED
 * wire order — `ContextExtension.values` is an insertion-ordered `Map`, matching
 * sigma-rust `ContextExtension.values: IndexMap` (`context_extension.rs`), which
 * `sigma_serialize` emits via `self.values.iter()` with NO re-sort. The order is
 * consensus-observable (the extension is part of `bytes_to_sign`), so a
 * varId-ascending re-sort would corrupt the signing message of any on-chain tx
 * whose extension is non-ascending. See
 * `docs/specs/2026-06-16-context-extension-order-preservation.md`.
 *
 * ContextExtension Constants are serialized version-agnostic: treeVersion 0 is
 * passed to parseSValue/serializeSValue, matching the harness's validate-tx.ts.
 */

import { ByteReader, ByteWriter } from '@ergots/scorex';
import { parseSType, parseSValue, serializeSType, serializeSValue, violatesCheckV6Type } from '@ergots/ergoscript';
import type { ContextExtension, Input } from '../types';
import { TxParseError } from '../errors';

/** JVM `ContextExtension.serializer.parse` (`ContextExtension.scala:52-66`). The count
 *  and each variable id are read as signed bytes (`r.getByte()`); a byte >= 0x80 is a
 *  negative JVM `Byte` and errors. Each value is read as `r.getValue()` reads a
 *  Constant, then checked by rule-1019 `CheckV6Type`. */
export function parseContextExtension(r: ByteReader): ContextExtension {
  const n = r.readU8();
  if (n >= 0x80) {
    // :53-55 (since sigma-state v4.0).
    throw new TxParseError(`context extension count byte 0x${n.toString(16)} is >= 0x80`, 'count-out-of-range');
  }
  const values: ContextExtension['values'] = new Map();
  for (let i = 0; i < n; i++) {
    const varId = r.readU8();
    if (varId >= 0x80) {
      // :58-60 (sigma-state >= 6.0.5, e4ef1b203, not version-gated) — before the value is read.
      throw new TxParseError(`context extension variable id 0x${varId.toString(16)} is >= 0x80`, 'extension-id-out-of-range');
    }
    // :61 `r.getValue()` — the value node takes one reader level (ValueSerializer.scala:396-398)
    // on top of its data's own levels, as a box register does. Lowered only on a normal return,
    // as the JVM's `r.level - 1` is: a Box value whose tree degrades leaves its levels behind.
    r.enterDepth();
    const tpe = parseSType(r);
    // :62 rule-1019 CheckV6Type on the declared type, checked before the data as the register leg does.
    if (violatesCheckV6Type(tpe)) {
      throw new TxParseError(`context extension variable ${varId} has a type containing Option, Header or UnsignedBigInt`, 'extension-v6-type');
    }
    // :65 `toMap` — a repeated id keeps its first position and takes the last value.
    values.set(varId, { tpe, value: parseSValue(tpe, 0, r) });
    r.exitDepth();
  }
  return { values };
}

/** JVM `ContextExtension.serializer.serialize` (`ContextExtension.scala:44-50`): at most
 *  127 entries (`:46-47`), the count written as one byte. Ids are written unchecked, as
 *  the JVM writes them (`:49`). */
export function serializeContextExtension(ext: ContextExtension, w: ByteWriter): void {
  if (ext.values.size > 0x7f) {
    throw new TxParseError(`context extension has ${ext.values.size} entries, more than 127`, 'count-out-of-range');
  }
  w.writeU8(ext.values.size);
  // Iterate in insertion (= received wire) order; NO sort (see header).
  for (const [id, e] of ext.values) {
    w.writeU8(id);
    serializeSType(e.tpe, w);
    serializeSValue(e.tpe, e.value, 0, w);
  }
}

export function parseInput(r: ByteReader): Input {
  const boxId = r.readBytes(32);
  const proofLen = r.readVlqU();
  const proofBytes = r.readBytes(proofLen);
  const contextExtension = parseContextExtension(r);
  return { boxId, spendingProof: { proofBytes, contextExtension } };
}

export function serializeInput(input: Input, w: ByteWriter): void {
  w.writeBytes(input.boxId);
  w.writeVlqU(input.spendingProof.proofBytes.length);
  w.writeBytes(input.spendingProof.proofBytes);
  serializeContextExtension(input.spendingProof.contextExtension, w);
}
