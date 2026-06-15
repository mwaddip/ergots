/**
 * ErgoBoxCandidate wire codec — the in-transaction box body with an INDEXED
 * token table.
 *
 * Source mapping:
 *   sigma-rust ergotree-ir/src/chain/ergo_box.rs
 *     serialize_box_with_indexed_digests (:357-411)
 *     parse_box_with_indexed_digests     (:415-470)
 *
 * Wire layout (sigma-rust `serialize_box_with_indexed_digests`,
 * `token_ids_in_tx = Some(table)` arm):
 *   value           — VLQ u64 (BoxValue::sigma_serialize; unsigned, NOT ZigZag)
 *   ergoTree bytes  — written verbatim, self-delimiting via the ErgoTree header
 *   creation_height — VLQ uint (`put_u32`; JVM reader is `getUIntExact`, i32 ceil)
 *   tokens_count    — raw u8 (`put_u8`, NOT VLQ)
 *   per-token       — token-table INDEX as VLQ uint (`put_u32`/`get_u32`) +
 *                     amount as VLQ u64 (`put_u64`/`get_u64`)
 *   additional_regs — raw u8 count + per-register `(SType || SValue)` Const/Tuple
 *
 * This is IDENTICAL to the standalone box body (`@ergots/ergoscript`'s
 * `serializeBoxBytesWithoutRef`) EXCEPT the token section: the standalone form
 * writes the inline 32-byte token id, the in-tx form writes a VLQ index into a
 * transaction-wide digest table built by the envelope (Task 6). So this codec
 * takes the table as a parameter — parse resolves id-by-index; serialize maps
 * id→index.
 *
 * The ergoTree-span read and the additional-registers section are consumed from
 * the shared `@ergots/ergoscript` readers (`parseErgoTreeBytes`,
 * `parseAdditionalRegisters`), which are the exact functions the ergoscript
 * `SBox` data parser uses — so box-body grammar (incl. the Tuple-Expr
 * `opaqueBytes` capture and the rule-1019 CheckV6Type register gate) is not
 * re-derived here. The register SERIALIZE loop mirrors ergoscript's
 * `writeBoxBodyWithoutRef` (dense-pack guard + opaqueBytes passthrough).
 *
 * MaxBoxSize window: the candidate parse arms a 4096-byte lazy position-limit
 * over the candidate span (value → registers; mirrors sigma-rust's
 * `ErgoBox::MAX_BOX_SIZE` window in `parse_box_with_indexed_digests` and the
 * JVM `ErgoBoxCandidate.parseBodyWithIndexedDigests`). It is restored after the
 * registers on the SUCCESS path only (no `finally` in the reference — a parse
 * error abandons the reader). Nested candidate parses (a `Coll[Box]` constant
 * inside a register) save/restore the outer window via the inner SBox arm.
 */

import { ByteReader, ByteWriter } from '@ergots/scorex';
import {
  serializeSType,
  serializeSValue,
  parseErgoTreeBytes,
  parseAdditionalRegisters,
} from '@ergots/ergoscript';
import type { ErgoBoxCandidate } from '../types';
import { TxParseError } from '../errors';
import { hex } from './_hex';

/**
 * JVM `ErgoBox.MaxBoxSize` = `SigmaConstants.MaxBoxSize` = 4 * 1024
 * (sigma-rust `ErgoBox::MAX_BOX_SIZE`). The candidate span parses under a lazy
 * `positionLimit` window of this size, armed at the candidate start and
 * restored after the registers loop.
 */
const ERGO_BOX_MAX_SIZE = 4096;

/**
 * Parse one `ErgoBoxCandidate` body from the reader, resolving each token's
 * 32-byte id from `tokenTable` by the on-wire VLQ index.
 *
 * `tokenTable` is the transaction-wide ordered digest table (built by the
 * envelope, Task 6); `tokenTable[idx]` is the id for wire index `idx`.
 */
export function parseBoxCandidate(r: ByteReader, tokenTable: Uint8Array[]): ErgoBoxCandidate {
  // Arm the 4096-byte MaxBoxSize candidate window (sigma-rust
  // parse_box_with_indexed_digests:430-432). Lazy + strict-`>`; the candidate
  // span ends with the registers. Save/set/restore INLINE (no finally) — a
  // window overrun abandons the parse exactly like the reference.
  const previousPositionLimit = r.positionLimit;
  r.positionLimit = r.position + ERGO_BOX_MAX_SIZE;

  // value — VLQ u64 (BoxValue::sigma_serialize), unsigned, NOT ZigZag.
  const value = r.readVlqBigInt();

  // ergoTree bytes — self-delimiting via header; captured verbatim by the
  // shared reader (ergoscript SBox path uses the same call).
  const ergoTreeBytes = parseErgoTreeBytes(r);

  // creation_height — VLQ (`get_u32`). The JVM consensus reader is
  // `getUIntExact` (i32 ceiling 2^31-1); ergoscript's SBox arm + serializer
  // enforce that bound, so reject here too for a stable round-trip.
  const creationHeight = r.readVlqU();
  if (creationHeight > 0x7fffffff) {
    throw new TxParseError(
      `box creation_height ${creationHeight} exceeds 2^31-1 (Int.MaxValue; JVM getUIntExact)`,
      'count-out-of-range',
    );
  }

  // tokens — raw u8 count (`get_u8`, NOT VLQ), then per-token (VLQ table index,
  // VLQ u64 amount).
  const nTokens = r.readU8();
  const tokens: { id: Uint8Array; amount: bigint }[] = [];
  for (let i = 0; i < nTokens; i++) {
    const idx = r.readVlqU(); // `get_u32` = VLQ uint
    const id = tokenTable[idx];
    if (id === undefined) {
      throw new TxParseError(
        `token table index ${idx} out of range (table size ${tokenTable.length})`,
        'token-table-index-out-of-range',
      );
    }
    const amount = r.readVlqBigInt(); // `get_u64` = VLQ u64
    tokens.push({ id, amount });
  }

  // additional_registers — raw u8 count + per-register Const/Tuple Expr. The
  // shared reader applies the rule-1019 CheckV6Type gate, the > 6 reject, and
  // the Tuple-Expr opaqueBytes capture identically to the SBox path. The
  // standalone box body is a v0 wire form (the JVM never lets v6-typed DATA
  // into registers via CheckV6Type), so treeVersion 0 is passed.
  const parsedRegisters = parseAdditionalRegisters(r, 0);

  // Restore the enclosing window on the SUCCESS path only (the candidate span
  // ends here; anything after — the txId/index in a full ErgoBox, or the next
  // candidate in the envelope — sits OUTSIDE this window).
  r.positionLimit = previousPositionLimit;

  // Narrow `AdditionalRegisters` (Record<number, T | undefined>) to the
  // candidate's `Record<number, T>` shape: the reader only ever assigns
  // defined entries (R4..R{4+n-1}), so the cast is sound.
  const registers = parsedRegisters as ErgoBoxCandidate['registers'];

  return { value, ergoTreeBytes, creationHeight, tokens, registers };
}

/**
 * Serialize an `ErgoBoxCandidate` body, mapping each token id to its index in
 * the transaction-wide digest table via `idToIndex` (keyed by lowercase hex of
 * the 32-byte id).
 *
 * Byte layout matches `parseBoxCandidate` (and sigma-rust
 * `serialize_box_with_indexed_digests`, `token_ids_in_tx = Some` arm).
 */
export function serializeBoxCandidate(
  b: ErgoBoxCandidate,
  idToIndex: Map<string, number>,
  w: ByteWriter,
): void {
  // value — VLQ u64, unsigned (NOT ZigZag).
  w.writeVlqBigInt(b.value);

  // ergoTree bytes — verbatim.
  w.writeBytes(b.ergoTreeBytes);

  // creation_height — VLQ; reject > 2^31-1 mirroring the parse bound (stable
  // round-trip; matches ergoscript's box-body serializer).
  if (!Number.isInteger(b.creationHeight) || b.creationHeight < 0 || b.creationHeight > 0x7fffffff) {
    throw new TxParseError(
      `box creation_height ${b.creationHeight} exceeds 2^31-1 (Int.MaxValue; JVM getUIntExact mirror)`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(b.creationHeight);

  // tokens — raw u8 count (NOT VLQ; the u8 ceiling 255 is the wire bound), then
  // per-token (VLQ table index + VLQ u64 amount).
  if (b.tokens.length > 255) {
    throw new TxParseError(
      `box tokens length ${b.tokens.length} exceeds the u8 wire ceiling (255)`,
      'count-out-of-range',
    );
  }
  w.writeU8(b.tokens.length);
  for (const t of b.tokens) {
    const idx = idToIndex.get(hex(t.id));
    if (idx === undefined) {
      throw new TxParseError(
        `token id ${hex(t.id)} not in tx digest table`,
        'token-table-index-out-of-range',
      );
    }
    w.writeVlqU(idx); // `put_u32` = VLQ uint
    w.writeVlqBigInt(t.amount); // `put_u64` = VLQ u64
  }

  // additional_registers — raw u8 count + per-register wire. Mirrors
  // ergoscript's writeBoxBodyWithoutRef: registers MUST be densely packed from
  // R4 (sigma-rust NonDenselyPacked, register.rs); the opaqueBytes form (a
  // Tuple-Expr register) is re-emitted verbatim, while a Const register is
  // re-emitted as `(SType || SValue)`.
  const regKeys = Object.keys(b.registers)
    .map((k) => Number(k))
    .filter((k) => k >= 4 && k <= 9 && b.registers[k] !== undefined)
    .sort((a, c) => a - c);
  for (let i = 0; i < regKeys.length; i++) {
    if (regKeys[i] !== 4 + i) {
      throw new TxParseError(
        `box registers must be densely packed from R4; found gap before R${4 + i}`,
        'count-out-of-range',
      );
    }
  }
  w.writeU8(regKeys.length);
  for (const k of regKeys) {
    const e = b.registers[k]!;
    if (e.opaqueBytes !== undefined) {
      // Tuple-Expr (or other non-Const Expr) register — emit captured bytes
      // verbatim; serializing via serializeSType+serializeSValue would produce
      // the STuple Constant form (different wire encoding) and break parity.
      w.writeBytes(e.opaqueBytes);
      continue;
    }
    // Standalone box body is a v0 wire form (v6-typed DATA never enters
    // registers per CheckV6Type), so treeVersion 0 is passed.
    serializeSType(e.tpe, w);
    serializeSValue(e.tpe, e.value, 0, w);
  }
}
