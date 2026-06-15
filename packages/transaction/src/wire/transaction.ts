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
import { parseInput, serializeInput } from './input';
import { parseDataInput, serializeDataInput } from './data-input';
import { parseBoxCandidate, serializeBoxCandidate } from './box-candidate';
import { TxParseError } from '../errors';

/**
 * `u16::MAX` — the cap `get_u16` (`vlq_encode.rs:255`) enforces by narrowing the
 * VLQ-decoded `u64` to `u16`. Inputs / data-inputs / outputs counts are bounded
 * by it (`Transaction::MAX_OUTPUTS_COUNT = u16::MAX`, transaction.rs:~108).
 */
const U16_MAX = 0xffff;

/**
 * `u32::MAX` — the cap `get_u32` (`vlq_encode.rs:267`) enforces on the tokens
 * count by narrowing the VLQ-decoded `u64` to `u32`.
 */
const U32_MAX = 0xffffffff;

/**
 * `Transaction::MAX_OUTPUTS_COUNT * ErgoBox::MAX_TOKENS_COUNT` = 65535 * 255 =
 * 16,711,425 — the explicit "too many tokens in transaction" bound the parser
 * checks before allocating the token IndexSet (transaction.rs:~308-312).
 */
const MAX_DISTINCT_TOKENS = U16_MAX * 255;

/** Lowercase hex of a byte array (token-id table-key form; matches box-candidate.ts). */
function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function parseTransaction(bytes: Uint8Array): ErgoLikeTransaction {
  const r = new ByteReader(bytes);

  // inputs — VLQ count (`get_u16`), then each Input.
  const nIn = r.readVlqU();
  if (nIn > U16_MAX) {
    throw new TxParseError(`inputs count ${nIn} exceeds u16::MAX (get_u16)`, 'count-out-of-range');
  }
  const inputs = Array.from({ length: nIn }, () => parseInput(r));

  // data-inputs — VLQ count (`get_u16`), then each DataInput.
  const nData = r.readVlqU();
  if (nData > U16_MAX) {
    throw new TxParseError(
      `data-inputs count ${nData} exceeds u16::MAX (get_u16)`,
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

  // outputs — VLQ count (`get_u16`), then each candidate body resolving token
  // indices against `tokenTable`.
  const nOut = r.readVlqU();
  if (nOut > U16_MAX) {
    throw new TxParseError(`outputs count ${nOut} exceeds u16::MAX (get_u16)`, 'count-out-of-range');
  }
  const outputCandidates = Array.from({ length: nOut }, () => parseBoxCandidate(r, tokenTable));

  // Reject trailing bytes — the JVM/sigma-rust consume the whole tx span; any
  // remainder means a malformed or extra-padded envelope.
  if (!r.isExhausted) {
    throw new TxParseError(`${r.remaining} trailing byte(s) after transaction`, 'trailing-bytes');
  }

  return { inputs, dataInputs, outputCandidates };
}

export function serializeTransaction(tx: ErgoLikeTransaction): Uint8Array {
  const w = new ByteWriter();

  // inputs — VLQ count (`put_usize_as_u16_unwrapped`; the cast panics on
  // overflow upstream, so reject the same range here), then each Input.
  if (tx.inputs.length > U16_MAX) {
    throw new TxParseError(
      `inputs count ${tx.inputs.length} exceeds u16::MAX (put_usize_as_u16)`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(tx.inputs.length);
  for (const i of tx.inputs) serializeInput(i, w);

  // data-inputs — VLQ count. sigma-rust models the empty case as `None` and
  // still writes `put_u16(0)`, so length-0 here is byte-identical to that arm.
  if (tx.dataInputs.length > U16_MAX) {
    throw new TxParseError(
      `data-inputs count ${tx.dataInputs.length} exceeds u16::MAX (put_usize_as_u16)`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(tx.dataInputs.length);
  for (const d of tx.dataInputs) serializeDataInput(d, w);

  // distinct token table — first-seen insertion order across all outputs,
  // de-duplicated (sigma-rust `distinct_token_ids` → `IndexSet::from_iter`).
  const table: Uint8Array[] = [];
  const idToIndex = new Map<string, number>();
  for (const o of tx.outputCandidates) {
    for (const t of o.tokens) {
      const k = hex(t.id);
      if (!idToIndex.has(k)) {
        idToIndex.set(k, table.length);
        table.push(t.id);
      }
    }
  }
  // Count is `put_u32`; the build above can never exceed it in practice, but the
  // reference reader would reject a wider value, so keep the symmetry.
  if (table.length > MAX_DISTINCT_TOKENS) {
    throw new TxParseError(
      `too many distinct tokens: ${table.length} > ${MAX_DISTINCT_TOKENS}`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(table.length);
  for (const id of table) w.writeBytes(id);

  // outputs — VLQ count (`put_usize_as_u16_unwrapped`), then each candidate body
  // emitting a VLQ table index per token via `idToIndex`.
  if (tx.outputCandidates.length > U16_MAX) {
    throw new TxParseError(
      `outputs count ${tx.outputCandidates.length} exceeds u16::MAX (put_usize_as_u16)`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(tx.outputCandidates.length);
  for (const o of tx.outputCandidates) serializeBoxCandidate(o, idToIndex, w);

  return w.toBytes();
}
