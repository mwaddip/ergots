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
import type { WasmCostOracle, OracleInputResult } from './wasm-oracle.js';
import { stringifyLossless } from './rest/json-bigint.js';
import type {
    BlockBundle, TxBundle, InputBundle, BlockParameters, ContextExtensionEntry,
} from './bundle-types.js';

const BOX_FETCH_CONCURRENCY = 64;

/**
 * Voting-epoch length per network. Votable parameters (`maxBlockCost`,
 * parameter 123 `BlockVersion`) are recorded in the extension only at
 * boundary blocks whose height is a multiple of this and are inherited by
 * every block until the next boundary.
 *
 * Mainnet: `votingLength = 1024` (ergo `src/main/resources/application.conf:263`).
 * Testnet: `votingLength = 128`  (ergo `src/main/resources/testnet.conf:49`).
 */
const VOTING_EPOCH_LENGTH: Record<'mainnet' | 'testnet', number> = {
    mainnet: 1024,
    testnet: 128,
};

/**
 * sigma-rust `Parameters::default().max_block_cost()` — genesis value, used
 * only as a last-resort fallback when no boundary ≤ height carries parameters
 * (i.e. pre-first-vote). The forward walk (h ≫ 0) never hits this.
 */
const GENESIS_MAX_BLOCK_COST = 1_000_000;

/**
 * Parameter 123 `BlockVersion`'s extension key: the system-parameters prefix
 * (`0x00`, `extension/Extension.scala:59`) followed by the parameter id
 * (`0x7b`, `settings/Parameters.scala:255`). Hex-encoded by the node.
 */
const EXT_KEY_BLOCK_VERSION = '007b';

/**
 * The launch value of parameter 123 `BlockVersion`, below the first voting
 * epoch's boundary (ergo `settings/LaunchParameters.scala:8-17`): 1 on
 * mainnet (`DefaultParameters`, `settings/Parameters.scala:329`), 4 on the
 * public testnet (`Header.Interpreter60Version`, `Header.scala:152`).
 */
const LAUNCH_BLOCK_VERSION: Record<'mainnet' | 'testnet', number> = {
    mainnet: 1,
    testnet: 4,
};

/**
 * Decode the four big-endian bytes the ergo node writes under key `007b`
 * with `Ints.toByteArray` (ergo `settings/Parameters.scala:220-222`) into
 * the JVM's Int. The caller takes `.toByte` of the result.
 */
function decodeBlockVersionInt(hexValue: string): number {
    if (hexValue.length !== 8) {
        throw new Error(
            `extension key ${EXT_KEY_BLOCK_VERSION}: expected 4 bytes big-endian (8 hex chars), got "${hexValue}"`,
        );
    }
    // Four big-endian bytes read as an unsigned Int32 — `>>> 0` keeps JS's
    // |0 from sign-extending the top byte on values 0x80000000 and above.
    // The JVM's `.toByte` wrap belongs to the caller (`signedBlockVersion`).
    return parseInt(hexValue, 16) >>> 0;
}

/** The value of extension key `007b` (an Int), or undefined if absent. */
function readBlockVersionFromExtension(fields: Array<[string, string]>): number | undefined {
    for (const [k, v] of fields) {
        if (k === EXT_KEY_BLOCK_VERSION) return decodeBlockVersionInt(v);
    }
    return undefined;
}

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
    /** The voting-epoch length of this walk's network, selected from
     *  `VOTING_EPOCH_LENGTH`. The two per-epoch caches key off a multiple
     *  of this. */
    private readonly votingLength: number;

    constructor(
        private readonly node: NodeClient,
        private readonly indexer: IndexerClient,
        private readonly oracle: WasmCostOracle,
        private readonly attachTxBytes = false,
        /** The network's launch block version is taken from this
         *  (`LAUNCH_BLOCK_VERSION`) when no epoch boundary ≤ height carries
         *  the parameter in its extension (ergo `settings/LaunchParameters.scala:8-17`).
         *  The voting-epoch length is drawn from the same key
         *  (`VOTING_EPOCH_LENGTH`): mainnet 1024, testnet 128. */
        private readonly network: 'mainnet' | 'testnet' = 'mainnet',
    ) {
        this.votingLength = VOTING_EPOCH_LENGTH[network];
    }

    /** epoch-boundary height → active maxBlockCost (resolved once per epoch). */
    private readonly maxBlockCostByEpoch = new Map<number, number>();

    /** epoch-boundary height → voted block version (the parameter, read as Int). */
    private readonly blockVersionByEpoch = new Map<number, number>();

    /**
     * Resolve the *active* `maxBlockCost` for `height`.
     *
     * `maxBlockCost` is a votable consensus parameter recorded only at
     * voting-epoch boundary blocks and inherited between them, so non-boundary
     * blocks carry `parameters: null`. We read the value from the last boundary
     * ≤ height (which the node already serves), cached per epoch. This mirrors
     * the node's state rather than re-deriving consensus — the only consensus
     * constant assumed is the well-known epoch length. Walking back epoch-by-
     * epoch is defensive; the computed boundary normally carries parameters.
     *
     * The parameter gates every transaction's cost ceiling, so this resolver
     * treats only two signals as "walk back": the boundary block is absent
     * (`ids.length === 0`), or it exists and carries no parameters. A REST
     * failure or a decode error is a halt the walk must see, not a silent
     * fallback to the previous epoch or the genesis default.
     */
    private async resolveActiveMaxBlockCost(height: number): Promise<number> {
        const target = Math.floor(height / this.votingLength) * this.votingLength;
        const cached = this.maxBlockCostByEpoch.get(target);
        if (cached !== undefined) return cached;
        for (let b = target; b >= 0; b -= this.votingLength) {
            const ids = await this.node.getHeaderIdsAtHeight(b);
            if (ids.length > 0) {
                const frags = await this.node.getValidationFragments(ids[0]!);
                if (frags.parameters !== null) {
                    this.maxBlockCostByEpoch.set(target, frags.parameters.maxBlockCost);
                    return frags.parameters.maxBlockCost;
                }
            }
            if (b === 0) break;
        }
        this.maxBlockCostByEpoch.set(target, GENESIS_MAX_BLOCK_COST);
        return GENESIS_MAX_BLOCK_COST;
    }

    /**
     * Resolve the *active* voted block version (parameter 123 `BlockVersion`)
     * for `height`. As with `maxBlockCost`, votable parameters are recorded
     * only at voting-epoch boundary blocks and inherited between them. The
     * value lives in the extension of the boundary block under key `007b`
     * (ergo `settings/Parameters.scala:255`, `:220-222`,
     * `modifiers/history/extension/Extension.scala:59`), four bytes
     * big-endian. Below the first boundary ≤ height that carries the key,
     * the network's launch value stands in
     * (`settings/LaunchParameters.scala:8-17`).
     */
    private async resolveActiveBlockVersion(height: number): Promise<number> {
        const target = Math.floor(height / this.votingLength) * this.votingLength;
        const cached = this.blockVersionByEpoch.get(target);
        if (cached !== undefined) return cached;
        for (let b = target; b >= 0; b -= this.votingLength) {
            // The parameter gates the activated script version, so this
            // resolver treats only two signals as "walk back": the boundary
            // block is absent (`ids.length === 0`), or it exists and carries
            // no `007b`. A REST failure or a malformed value is a halt the
            // walk must see, not a silent fallback to the previous epoch or
            // the launch value.
            const ids = await this.node.getHeaderIdsAtHeight(b);
            if (ids.length > 0) {
                const block = await this.node.getBlock(ids[0]!);
                const fromExt = readBlockVersionFromExtension(block.extension.fields);
                if (fromExt !== undefined) {
                    this.blockVersionByEpoch.set(target, fromExt);
                    return fromExt;
                }
            }
            if (b === 0) break;
        }
        const launch = LAUNCH_BLOCK_VERSION[this.network];
        this.blockVersionByEpoch.set(target, launch);
        return launch;
    }

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

        // ergo 6.0.8's `bsCorrespondsToHeader` (Header.scala:104-108,
        // FullBlockSectionProcessor.scala:99): a transactions section whose
        // marker differs from its header's version is refused. The halt stops
        // the walk on such a block.
        const sectionBlockVersion = block.blockTransactions.blockVersion;
        if (sectionBlockVersion !== block.header.version) {
            throw new Error(
                `/blocks/${headerId}: section blockVersion ${sectionBlockVersion} ` +
                `differs from the header's version ${block.header.version} ` +
                `(ergo 6.0.8 bsCorrespondsToHeader refuses the section)`,
            );
        }

        // When this block is the epoch boundary (its height is a multiple of
        // the voting length), seed the per-epoch cache from its extension's
        // key `007b` directly. A non-boundary block that happens to carry
        // the key is not an authoritative source for the epoch, so it is
        // left to `resolveActiveBlockVersion`.
        if (height % this.votingLength === 0) {
            const fromThisBlock = readBlockVersionFromExtension(block.extension.fields);
            if (fromThisBlock !== undefined) {
                this.blockVersionByEpoch.set(height, fromThisBlock);
            }
        }

        // Resolve the *active* maxBlockCost for this height once — used for both
        // the oracle's per-tx cost limit and the evaluator's jitCostLimit
        // (iter-26). Recorded only at epoch boundaries and inherited between
        // them, so non-boundary blocks (parameters === null) read the last
        // boundary ≤ height; boundary blocks seed the per-epoch cache.
        let activeMaxBlockCost: number;
        if (fragments.parameters !== null) {
            activeMaxBlockCost = fragments.parameters.maxBlockCost;
            this.maxBlockCostByEpoch.set(
                Math.floor(height / this.votingLength) * this.votingLength,
                activeMaxBlockCost,
            );
        } else {
            activeMaxBlockCost = await this.resolveActiveMaxBlockCost(height);
        }

        // Resolve the active voted block version, the second voted parameter
        // this bundle carries. `validateStateful` reads it off
        // `stateContext.parameters.blockVersion` for the activated script
        // version, the height rules and the output write's context.
        const activeBlockVersion = await this.resolveActiveBlockVersion(height);

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
            // lib and ids modes (the capstone false-reject walk, and the
            // ids-and-parse-only walk): the WASM cost oracle is NOT invoked (spec
            // decision 3) and the tx bytes come from the node's validation-fragments
            // (CAP-A, below), so ergo-lib-wasm is not used at all. validate-tx-lib
            // and validate-tx-ids ignore the per-input oracle fields, so stub them.
            const oracleResults: OracleInputResult[] = this.attachTxBytes
                ? tx.inputs.map(() => ({ oracleCost: 0n, oracleSucceeded: true, oracleError: null }))
                : this.oracle.computeTxOracleCosts({
                      txJson: stringifyLossless(tx),
                      spentBoxesBytes,
                      dataInputBoxesBytes,
                      headerBytes,
                      rollingHeaderBytes,
                      // active value (not raw fragments.parameters, which is null off
                      // epoch boundaries) so the oracle's cost limit matches ours.
                      parameters: { maxBlockCost: activeMaxBlockCost },
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
            // CAP-A: in the lib and ids modes feed parseTransaction the node's TRUE on-chain
            // bytes (validation-fragments `bytes` — full sigma_serialize with
            // ContextExtensions in wire order). The previous serializeTx(from_json)
            // path re-sorted non-ascending extension keys ascending, producing a
            // wrong bytes_to_sign for non-canonical txs (the h=224312 tx15
            // false-reject halt). Round-trips byte-identically through ergots'
            // parseTransaction/serializeTransaction (verified h=224312, 18/18).
            let txBytes: Uint8Array | undefined;
            if (this.attachTxBytes) {
                const fb = fragments.transactions[txi]!.bytes;
                if (fb === undefined) {
                    throw new Error(
                        `validation-fragments transactions[${txi}] missing 'bytes' — ` +
                        `the lib and ids modes need the true on-chain tx bytes (node must serve it)`,
                    );
                }
                txBytes = hexDecode(fb);
            }
            transactions.push({
                txId: hexDecode(tx.id),
                signingMessage,
                inputs,
                outputs: outputBoxesBytes,
                dataInputBoxes: dataInputBoxesBytes,
                txBytes,
            });
        }
        const parameters: BlockParameters = {
            maxBlockCost: activeMaxBlockCost,
            blockVersion: activeBlockVersion,
        };
        return {
            height,
            blockId: hexDecode(headerId),
            parentId: hexDecode(block.header.parentId),
            headerBytes,
            headerJson,
            transactions,
            parameters,
            sectionBlockVersion,
        };
    }
}
