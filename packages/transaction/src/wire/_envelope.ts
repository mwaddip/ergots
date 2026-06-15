/**
 * Shared transaction-envelope writer — the single source of truth for the wire
 * body that both `serializeTransaction` (full, with proofs) and `signingMessage`
 * (`bytes_to_sign`, proofs replaced by `ProofBytes::Empty`) emit. The ONLY
 * difference between the two forms is the per-input proof, so the section order,
 * count writes, io-count bounds, and the distinct-token-table build all live here
 * exactly once.
 *
 * Source mapping (sigma-rust, read via
 * `git show ergo-node-integration:ergo-lib/src/chain/transaction.rs`):
 *   sigma_serialize (:~248-285)        — the full envelope (full proofs)
 *   bytes_to_sign   (:184-190)         — same envelope after
 *                                        `inputs.mapped_ref(|i| i.input_to_sign())`
 *   input_to_sign   (input.rs:112-120) — keeps box_id + extension, proof → Empty
 *   distinct_token_ids (:~227-237)     — IndexSet first-seen across all outputs
 *   calc_tx_id      (:178-181)         — blake2b256_hash(bytes_to_sign())
 *
 * `includeProofs = true`  → byte-identical to `Input::sigma_serialize`
 *                           (boxId + VLQ proofLen + proofBytes + extension).
 * `includeProofs = false` → the signing form: boxId + VLQ(0) + extension.
 *
 * Signing-form proof note (VERIFIED against the reference, load-bearing for the
 * txId hash): an `Input` carrying `ProofBytes::Empty` does NOT drop the proof
 * field — `ProverResult::sigma_serialize` writes `proof.sigma_serialize` then
 * `extension.sigma_serialize`, and `ProofBytes::Empty` serializes as `put_u16(0)`
 * = a VLQ length of 0 (prover_result.rs:81-90, 39-43). So the signing message is
 * "boxId + (empty proof = VLQ 0) + extension", NOT "boxId + extension". Omitting
 * that zero-length VLQ would shift every following byte and change the blake2b256
 * txId, so the no-proofs branch writes the explicit `writeVlqU(0)`.
 */

import type { ByteWriter } from '@ergots/scorex';
import type { ErgoLikeTransaction } from '../types';
import { serializeInput, serializeContextExtension } from './input';
import { serializeDataInput } from './data-input';
import { serializeBoxCandidate } from './box-candidate';
import { TxParseError } from '../errors';

/**
 * `i16::MAX` = 32767 — upper bound of `TxIoVec<T>` (`BoundedVec<T, 1, i16::MAX>`,
 * ergotree-ir/src/chain/context.rs:23). Inputs and output-candidates require
 * `[1, TX_IO_MAX]`; data-inputs allow `{0} ∪ [1, TX_IO_MAX]`.
 */
export const TX_IO_MAX = 0x7fff;

/**
 * `Transaction::MAX_OUTPUTS_COUNT * ErgoBox::MAX_TOKENS_COUNT` = 65535 * 255 =
 * 16,711,425 — the "too many tokens in transaction" bound checked before the
 * token IndexSet is allocated (transaction.rs:~308-312).
 */
const U16_MAX = 0xffff;
export const MAX_DISTINCT_TOKENS = U16_MAX * 255;

/** Lowercase hex of a byte array (token-id table-key form; matches box-candidate.ts). */
export function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * Write the full transaction envelope into `w`. When `includeProofs` is true the
 * output is byte-identical to `Transaction::sigma_serialize`; when false it is the
 * signing message (`bytes_to_sign`) — every input's proof reduced to the empty
 * proof (VLQ length 0), extension and all other sections unchanged.
 *
 * io-count bounds are enforced here so BOTH paths reject zero-io / >TX_IO_MAX
 * (a serializer must never emit a count the reference parser would reject).
 */
export function writeEnvelope(
  tx: ErgoLikeTransaction,
  w: ByteWriter,
  includeProofs: boolean,
): void {
  // inputs — TxIoVec requires [1, i16::MAX=32767].
  if (tx.inputs.length < 1 || tx.inputs.length > TX_IO_MAX) {
    throw new TxParseError(
      `inputs count ${tx.inputs.length} out of TxIoVec range [1, ${TX_IO_MAX}]`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(tx.inputs.length);
  for (const i of tx.inputs) {
    if (includeProofs) {
      serializeInput(i, w);
    } else {
      // input_to_sign: box_id + (proof = Empty) + extension. The empty proof
      // still serializes as a VLQ length of 0 (Input::sigma_serialize writes
      // `proof.sigma_serialize`, and ProofBytes::Empty emits put_usize_as_u32(0)).
      w.writeBytes(i.boxId);
      w.writeVlqU(0);
      serializeContextExtension(i.spendingProof.contextExtension, w);
    }
  }

  // data-inputs — 0 → None (allowed, still writes VLQ 0); non-zero ≤ TX_IO_MAX.
  if (tx.dataInputs.length > TX_IO_MAX) {
    throw new TxParseError(
      `data-inputs count ${tx.dataInputs.length} out of range [0, ${TX_IO_MAX}]`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(tx.dataInputs.length);
  for (const d of tx.dataInputs) serializeDataInput(d, w);

  // distinct token table — first-seen insertion order across all outputs,
  // de-duplicated (`distinct_token_ids` → `IndexSet::from_iter`).
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
  if (table.length > MAX_DISTINCT_TOKENS) {
    throw new TxParseError(
      `too many distinct tokens: ${table.length} > ${MAX_DISTINCT_TOKENS}`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(table.length);
  for (const id of table) w.writeBytes(id);

  // outputs — TxIoVec requires [1, i16::MAX=32767].
  if (tx.outputCandidates.length < 1 || tx.outputCandidates.length > TX_IO_MAX) {
    throw new TxParseError(
      `outputs count ${tx.outputCandidates.length} out of TxIoVec range [1, ${TX_IO_MAX}]`,
      'count-out-of-range',
    );
  }
  w.writeVlqU(tx.outputCandidates.length);
  for (const o of tx.outputCandidates) serializeBoxCandidate(o, idToIndex, w);
}
