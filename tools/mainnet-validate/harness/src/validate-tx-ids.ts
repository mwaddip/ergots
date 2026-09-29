/**
 * Ids-and-parse-only per-tx validator (`--mode ids`; spec 2026-09-28 §12 and Tests §4, the merge
 * gate). No script evaluation: it checks that ergots parses the transaction the chain accepted
 * and derives the chain's identifiers from it.
 *
 *   - The transaction id: `transactionId(parseTransaction(txBytes))`, whose signing message writes
 *     each output tree re-encoded, as the JVM's `bytesToSign` does (`ErgoLikeTransaction.scala:49`,
 *     `:192-198`, through the candidate serializer, `ErgoBoxCandidate.scala:142`), against the id
 *     the node reports.
 *   - Each output box: the JVM constructs a transaction's outputs from its candidates
 *     (`ErgoLikeTransaction.scala:46-47`), so an output's `bytes`, and the box id hashed from them,
 *     write the tree re-encoded. ergots builds the same box and serializes it; the bytes must equal
 *     the indexer's. The indexer client checks `blake2b256(bytes)` against the box id the node's
 *     block lists (`rest/indexer-client.ts`), so equal bytes also mean ergots' output box id is the
 *     chain's.
 *
 * `txBytes` is the node's serialized transaction (validation-fragments `bytes`), which the
 * assembler attaches in the lib and ids modes. The candidates `parseTransaction` returns carry the
 * tree instances box ingest seeded, and the box built from each keeps that instance, so the
 * re-encodings reuse the ingest parse.
 */

import { ByteWriter } from '@ergots/scorex';
import { serializeSValue } from '@ergots/ergoscript';
import type { ErgoBox } from '@ergots/ergoscript';
import { parseTransaction, transactionId } from '@ergots/transaction';
import type { ErgoLikeTransaction } from '@ergots/transaction';

import type { BlockBundle, TxBundle } from './bundle-types.js';
import { HarnessError } from './errors.js';
import type { WalkerState } from './validate-block.js';

/** Same call signature as `validateTx` / `validateTxLib`, so it drops into `validateBlock`. */
export function validateTxIds(tx: TxBundle, _block: BlockBundle, _state: WalkerState, txIndex: number): void {
    if (tx.txBytes === undefined) {
        throw new HarnessError(
            'ids',
            'ids-tx-bytes-missing',
            `txBytes missing at tx ${txIndex}: the assembler attaches them in the lib and ids modes`,
            { txIndex },
        );
    }
    const txIdHex = bytesToHex(tx.txId);

    let parsed: ErgoLikeTransaction;
    try {
        parsed = parseTransaction(tx.txBytes);
    } catch (err) {
        throw new HarnessError(
            'ids',
            'ids-parse-failed',
            `parseTransaction failed at tx ${txIndex}: ${messageOf(err)}`,
            { txIndex, txId: txIdHex },
        );
    }

    let id: Uint8Array;
    try {
        id = transactionId(parsed);
    } catch (err) {
        throw new HarnessError(
            'ids',
            'ids-tx-id-failed',
            `transactionId failed at tx ${txIndex}: ${messageOf(err)}`,
            { txIndex, txId: txIdHex },
        );
    }
    if (!bytesEqual(id, tx.txId)) {
        throw new HarnessError(
            'ids',
            'tx-id-mismatch',
            `tx ${txIndex}: ergots id ${bytesToHex(id)} differs from the chain's ${txIdHex}`,
            { txIndex, txId: txIdHex },
        );
    }

    if (parsed.outputCandidates.length !== tx.outputs.length) {
        throw new HarnessError(
            'ids',
            'output-count-mismatch',
            `tx ${txIndex}: ergots parsed ${parsed.outputCandidates.length} outputs, the chain lists ${tx.outputs.length}`,
            { txIndex, txId: txIdHex },
        );
    }
    parsed.outputCandidates.forEach((c, i) => {
        const location = { txIndex, txId: txIdHex, outputIndex: i };
        const box: ErgoBox = { ...c, txId: tx.txId, index: i };
        let bytes: Uint8Array;
        try {
            const w = new ByteWriter();
            serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, 0, w);
            bytes = w.toBytes();
        } catch (err) {
            throw new HarnessError(
                'ids',
                'ids-output-serialize-failed',
                `serializing output ${i} of tx ${txIndex} failed: ${messageOf(err)}`,
                location,
            );
        }
        if (!bytesEqual(bytes, tx.outputs[i]!)) {
            throw new HarnessError(
                'ids',
                'output-bytes-mismatch',
                `tx ${txIndex} output ${i}: the re-encoded box differs from the chain's`,
                location,
            );
        }
    });
}

function messageOf(err: unknown): string {
    return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function bytesToHex(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
    return s;
}
