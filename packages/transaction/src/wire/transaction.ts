/**
 * ErgoLikeTransaction envelope codec — the outermost wire layer that frames the
 * inputs, data-inputs, the transaction-wide distinct-token digest table, and the
 * output candidates. This is the fixture gate: real testnet transaction bytes
 * must round-trip byte-identically through parse → serialize.
 *
 * Source mapping (sigma-rust `Transaction`, read via
 * `git show ergo-node-integration:ergo-lib/src/chain/transaction.rs`):
 *   sigma_serialize (:~248-285) / sigma_parse (:~287-330)
 *   distinct_token_ids (:~227-237)
 *
 * Wire layout (`Transaction::sigma_serialize`, the whole body wrapped in
 * `w.with_tree_version(ErgoTreeVersion::V0, …)` — registers/extensions are a v0
 * wire form, which the Input/box-candidate codecs already honor by passing
 * treeVersion 0):
 *
 *   inputs_count        — VLQ  (`put_usize_as_u16_unwrapped` → `put_u16` → `put_u64`)
 *   inputs[]            — each Input::sigma_serialize (wire/input.ts)
 *   data_inputs_count   — VLQ  (`put_usize_as_u16_unwrapped`, or `put_u16(0)` when None)
 *   data_inputs[]       — each DataInput::sigma_serialize (wire/data-input.ts)
 *   tokens_count        — VLQ  (`put_u32` → `put_u64`)
 *   token_ids[]         — distinct token ids, 32 bytes each, FIRST-SEEN order
 *   outputs_count       — VLQ  (`put_usize_as_u16_unwrapped`)
 *   output_candidates[] — each ErgoBoxCandidate::serialize_body_with_indexed_digests
 *                         with `token_ids_in_tx = Some(table)` (wire/box-candidate.ts)
 *
 * VLQ-vs-fixed-width: the count `put_u16`/`put_u32` in sigma-rust are *named*
 * for their cast width but route straight through `put_u64`, i.e. they are VLQ,
 * NOT fixed 2-/4-byte big-endian (`vlq_encode.rs:56,78` → `:94`). The matching
 * `get_u16`/`get_u32` decode `get_u64` (VLQ) then narrow-cast with a range check
 * (`:255-272`). So every count here is `readVlqU`/`writeVlqU`; the narrowing
 * range checks are reproduced as the bounds below.
 *
 * Token table = `distinct_token_ids(&self.output_candidates)`: an `IndexSet`
 * built by `flat_map`-ing every output candidate's tokens in output order then
 * `from_iter` — i.e. distinct ids in FIRST-SEEN insertion order across all
 * outputs, de-duplicated. The box-candidate codec writes a VLQ *index* into this
 * table per token, so the envelope owns table construction (serialize) and table
 * resolution (parse).
 */

import { ByteReader, ByteWriter } from '@ergots/scorex';
import type { ErgoLikeTransaction } from '../types';
import { parseInput } from './input';
import { parseDataInput } from './data-input';
import { parseBoxCandidate } from './box-candidate';
import { writeEnvelope, TX_IO_MAX, MAX_DISTINCT_TOKENS } from './_envelope';
import { TxParseError } from '../errors';

/**
 * `u32::MAX` — the cap `get_u32` (`vlq_encode.rs:267`) enforces on the tokens
 * count by narrowing the VLQ-decoded `u64` to `u32`. Parse-side only; the
 * serialize-side bounds (TX_IO_MAX, MAX_DISTINCT_TOKENS) live in `_envelope.ts`
 * alongside the shared writer.
 */
const U32_MAX = 0xffffffff;

export function parseTransaction(bytes: Uint8Array): ErgoLikeTransaction {
  const r = new ByteReader(bytes);

  // inputs — VLQ count, then each Input.
  // TxIoVec requires [1, i16::MAX=32767] (ergotree-ir/src/chain/context.rs:23);
  // `get_u16` gates at u16::MAX then `new_from_vec` rejects 0 and >32767.
  // We mirror the rejection BEFORE the loop so we fail fast without allocating.
  const nIn = r.readVlqU();
  if (nIn < 1 || nIn > TX_IO_MAX) {
    throw new TxParseError(
      `inputs count ${nIn} out of TxIoVec range [1, ${TX_IO_MAX}]`,
      'count-out-of-range',
    );
  }
  const inputs = Array.from({ length: nIn }, () => parseInput(r));

  // data-inputs — VLQ count, then each DataInput.
  // sigma-rust uses `BoundedVec::opt_empty_vec`: 0 → None (allowed), otherwise [1, 32767].
  const nData = r.readVlqU();
  if (nData > TX_IO_MAX) {
    throw new TxParseError(
      `data-inputs count ${nData} out of range [0, ${TX_IO_MAX}]`,
      'count-out-of-range',
    );
  }
  const dataInputs = Array.from({ length: nData }, () => parseDataInput(r));

  // distinct token-id table — VLQ count (`get_u32`) bounded by MAX_DISTINCT_TOKENS,
  // then `nTokens` raw 32-byte ids in first-seen order.
  const nTokens = r.readVlqU();
  if (nTokens > U32_MAX) {
    throw new TxParseError(
      `token count ${nTokens} exceeds u32::MAX (get_u32)`,
      'count-out-of-range',
    );
  }
  if (nTokens > MAX_DISTINCT_TOKENS) {
    throw new TxParseError(
      `too many tokens in transaction: ${nTokens} > ${MAX_DISTINCT_TOKENS}`,
      'count-out-of-range',
    );
  }
  const tokenTable = Array.from({ length: nTokens }, () => r.readBytes(32));

  // outputs — VLQ count, then each candidate body resolving token indices
  // against `tokenTable`. TxIoVec requires [1, i16::MAX=32767].
  const nOut = r.readVlqU();
  if (nOut < 1 || nOut > TX_IO_MAX) {
    throw new TxParseError(
      `outputs count ${nOut} out of TxIoVec range [1, ${TX_IO_MAX}]`,
      'count-out-of-range',
    );
  }
  const outputCandidates = Array.from({ length: nOut }, () => parseBoxCandidate(r, tokenTable));

  // Reject trailing bytes — the JVM/sigma-rust consume the whole tx span; any
  // remainder means a malformed or extra-padded envelope.
  if (!r.isExhausted) {
    throw new TxParseError(`${r.remaining} trailing byte(s) after transaction`, 'trailing-bytes');
  }

  return { inputs, dataInputs, outputCandidates };
}

/**
 * Full transaction serialization (`Transaction::sigma_serialize`). Delegates to
 * the shared `writeEnvelope` writer (the entire envelope is identical to the
 * signing form except the per-input proof block); `includeProofs = true` emits
 * the proof-length VLQ + proof bytes. The io-count and token-table bounds — and
 * the distinct-token first-seen table build — all live in `writeEnvelope`.
 */
export function serializeTransaction(tx: ErgoLikeTransaction): Uint8Array {
  const w = new ByteWriter();
  writeEnvelope(tx, w, true);
  return w.toBytes();
}
