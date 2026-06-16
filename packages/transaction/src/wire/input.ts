/**
 * Input + SpendingProof + ContextExtension wire codec.
 *
 * Source mapping:
 *   sigma-rust ergotree-ir/src/chain/transaction/input.rs    — Input, ProverResult
 *   sigma-rust ergotree-ir/src/chain/context_extension.rs    — ContextExtension
 *
 * Wire layout (sigma-rust `sigma_serialize`):
 *   boxId:           32 bytes (no length prefix)
 *   proofBytes:      VLQ-u32 length, then that many bytes
 *   contextExtension VLQ-u32 count, then each entry:
 *                      varId:  1 byte (u8)
 *                      tpe:    SType wire encoding
 *                      value:  SValue wire encoding
 *
 * Byte-identity strategy: re-serialize from the decoded map, entries sorted by
 * varId ascending. This matches the canonical on-chain encoding. If a future
 * transaction fixture round-trip reveals non-canonical on-chain ordering, the
 * fallback is span-capture.
 *
 * ContextExtension Constants are serialized version-agnostic: treeVersion 0 is
 * passed to parseSValue/serializeSValue, matching the harness's validate-tx.ts.
 */

import { ByteReader, ByteWriter } from '@ergots/scorex';
import { parseSType, parseSValue, serializeSType, serializeSValue } from '@ergots/ergoscript';
import type { ContextExtension, Input } from '../types';

export function parseContextExtension(r: ByteReader): ContextExtension {
  const n = r.readVlqU();
  const values: ContextExtension['values'] = {};
  for (let i = 0; i < n; i++) {
    const varId = r.readU8();
    const tpe = parseSType(r);
    const value = parseSValue(tpe, 0, r);
    values[varId] = { tpe, value };
  }
  return { values };
}

export function serializeContextExtension(ext: ContextExtension, w: ByteWriter): void {
  const ids = Object.keys(ext.values).map(Number).sort((a, b) => a - b);
  w.writeVlqU(ids.length);
  for (const id of ids) {
    const e = ext.values[id]!;
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
