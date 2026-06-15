/**
 * Transaction signing message (`bytes_to_sign`) + transaction id.
 *
 * Source mapping (sigma-rust, read via
 * `git show ergo-node-integration:ergo-lib/src/chain/transaction.rs`):
 *   bytes_to_sign (:184-190) — serialize the tx after replacing every input's
 *                              proof with `ProofBytes::Empty` (extension kept).
 *   calc_tx_id    (:178-181) — `TxId(blake2b256_hash(bytes_to_sign()))`.
 *
 * The signing message is the verifier's Fiat–Shamir message and the pre-image of
 * the transaction id. It shares the ENTIRE envelope with the full serialization
 * except the per-input proof, so both go through the one `writeEnvelope` writer.
 *
 * `transactionId` returns the 32 raw digest bytes; the node-reported id is the
 * lowercase base16 of these bytes (TxId derives `Display` from `Digest32`).
 */

import { ByteWriter, blake2b256 } from '@ergots/scorex';
import type { ErgoLikeTransaction } from '../types';
import { writeEnvelope } from './_envelope';

/** `bytes_to_sign`: full envelope with every input's proof reduced to empty. */
export function signingMessage(tx: ErgoLikeTransaction): Uint8Array {
  const w = new ByteWriter();
  writeEnvelope(tx, w, false);
  return w.toBytes();
}

/** `calc_tx_id`: blake2b256 of the signing message (32 raw bytes). */
export function transactionId(tx: ErgoLikeTransaction): Uint8Array {
  return blake2b256(signingMessage(tx));
}
