/**
 * Composes BlockBundle from REST fragments + indexer-served box bytes
 * + WASM oracle results. Concurrent box fetch (bound 64). Per spec §3.2.
 *
 * Per-block flow:
 *   1. getHeaderIdsAtHeight(h) → headerId (first in the array)
 *   2. parallel: getBlock(id) + getValidationFragments(id)
 *   3. dedupe all box ids (inputs + data-inputs + outputs across all txs)
 *      and parallel-fetch via indexer (concurrency bound 64)
 *   4. per-tx: call WasmCostOracle.computeTxOracleCosts (per-tx, not per-input)
 *      passing the tx's JSON + spent-box bytes + data-input bytes +
 *      header JSON + rolling headers JSON + parameters
 *   5. assemble BlockBundle in-memory
 *
 * NOTE: the assemble() signature takes `rollingHeadersJson: string[]` (not
 * `rollingHeadersBytes: Uint8Array[]` as the original plan example showed)
 * because the WASM `BlockHeader` binding only exposes `from_json` — there
 * is no `sigma_parse_bytes` constructor for headers. See wasm-oracle.ts
 * docstring "Header input shape (deviation from PLAN-2j-rest.md T2)" for
 * the full rationale. The current block's header JSON is extracted from
 * the node's `/blocks/{id}` response via JSON.stringify(block.header);
 * the caller maintains the rolling window across blocks.
 */

import type { NodeClient } from './rest/node-client.js';
import type { IndexerClient } from './rest/indexer-client.js';
import type { WasmCostOracle } from './wasm-oracle.js';
import { stringifyLossless } from './rest/json-bigint.js';
import type {
    BlockBundle, TxBundle, InputBundle, BlockParameters, ContextExtensionEntry,
} from './bundle-types.js';

const BOX_FETCH_CONCURRENCY = 64;

function hexDecode(s: string): Uint8Array {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** Run `fn` concurrently over `items` with a max-in-flight cap. */
async function parallelMap<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(limit, items.length); w++) {
        workers.push((async () => {
            while (true) {
                const i = next++;
                if (i >= items.length) return;
                out[i] = await fn(items[i]!, i);
            }
        })());
    }
    await Promise.all(workers);
    return out;
}

export class BundleAssembler {
    constructor(
        private readonly node: NodeClient,
        private readonly indexer: IndexerClient,
        private readonly oracle: WasmCostOracle,
    ) {}

    /**
     * Assemble a BlockBundle for height `h`.
     *
     * `rollingHeaderBytes` is the up-to-10-newest-first preceding-header
     * scorex bytes (from prior `assemble` calls). On first block they
     * may be empty; WASM oracle's padding handles that.
     */
    async assemble(height: number, rollingHeaderBytes: Uint8Array[]): Promise<BlockBundle> {
        const ids = await this.node.getHeaderIdsAtHeight(height);
        if (ids.length === 0) throw new Error(`/blocks/at/${height} returned empty`);
        const headerId = ids[0]!;
        const [block, fragments] = await Promise.all([
            this.node.getBlock(headerId),
            this.node.getValidationFragments(headerId),
        ]);
        if (fragments.transactions.length !== block.blockTransactions.transactions.length) {
            throw new Error(
                `fragments transactions len=${fragments.transactions.length} ` +
                `!= block transactions len=${block.blockTransactions.transactions.length}`,
            );
        }
        // Dedupe all box ids referenced in the block.
        const boxIdSet = new Set<string>();
        for (const tx of block.blockTransactions.transactions) {
            for (const i of tx.inputs) boxIdSet.add(i.boxId);
            for (const d of tx.dataInputs) boxIdSet.add(d.boxId);
            for (const o of tx.outputs) boxIdSet.add(o.boxId);
        }
        const boxIds = [...boxIdSet];
        const fetched = await parallelMap(boxIds, BOX_FETCH_CONCURRENCY, (id) => this.indexer.getBoxBytes(id));
        const boxBytesById = new Map<string, Uint8Array>();
        for (let i = 0; i < boxIds.length; i++) boxBytesById.set(boxIds[i]!, fetched[i]!);

        const headerBytes = hexDecode(fragments.headerBytes);
        // Use the full raw node header JSON (block.header.rawJson), NOT
        // JSON.stringify(block.header). The latter would only include the 4
        // typed fields on HeaderJson and strip adProofsRoot, transactionsRoot,
        // stateRoot, extensionHash, powSolutions, votes, nBits, timestamp, and
        // unparsedBytes — all of which BlockHeader.from_json (WASM) requires.
        const headerJson = block.header.rawJson;
        const transactions: TxBundle[] = [];
        for (let txi = 0; txi < block.blockTransactions.transactions.length; txi++) {
            const tx = block.blockTransactions.transactions[txi]!;
            const signingMessage = hexDecode(fragments.transactions[txi]!.signingMessage);
            const spentBoxesBytes = tx.inputs.map((i) => boxBytesById.get(i.boxId)!);
            const dataInputBoxesBytes = tx.dataInputs.map((d) => boxBytesById.get(d.boxId)!);
            const outputBoxesBytes = tx.outputs.map((o) => boxBytesById.get(o.boxId)!);
            const oracleResults = this.oracle.computeTxOracleCosts({
                txJson: stringifyLossless(tx),
                spentBoxesBytes,
                dataInputBoxesBytes,
                headerBytes,
                rollingHeaderBytes,
                parameters: fragments.parameters,
            });
            const inputs: InputBundle[] = tx.inputs.map((i, ii) => {
                const ctxExt: ContextExtensionEntry[] = Object.entries(i.spendingProof.extension).map(([varId, hex]) => ({
                    varId: parseInt(varId, 10),
                    valueBytes: hexDecode(hex),
                }));
                return {
                    boxId: hexDecode(i.boxId),
                    spentBoxBytes: boxBytesById.get(i.boxId)!,
                    signatureBytes: hexDecode(i.spendingProof.proofBytes),
                    contextExtension: ctxExt,
                    oracleCost: oracleResults[ii]!.oracleCost,
                    oracleSucceeded: oracleResults[ii]!.oracleSucceeded,
                    oracleError: oracleResults[ii]!.oracleError,
                };
            });
            transactions.push({
                txId: hexDecode(tx.id),
                signingMessage,
                inputs,
                outputs: outputBoxesBytes,
                dataInputBoxes: dataInputBoxesBytes,
            });
        }
        const parameters: BlockParameters | null = fragments.parameters !== null
            ? { maxBlockCost: fragments.parameters.maxBlockCost }
            : null;
        return {
            height,
            blockId: hexDecode(headerId),
            parentId: hexDecode(block.header.parentId),
            headerBytes,
            headerJson,
            transactions,
            parameters,
        };
    }
}
