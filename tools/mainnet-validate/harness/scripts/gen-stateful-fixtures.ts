/**
 * Stateful transaction fixture generator for @ergots/transaction.
 *
 * Connects to the testnet ergo-node-rust at :9053 and the indexer at :9054,
 * captures (tx + spent input boxes + data-input boxes + 10 preceding headers +
 * preHeader + parameters) and writes each as a self-contained JSON to
 * packages/transaction/test/fixtures/stateful/<txid>.json.
 *
 * Usage (from repo root):
 *   node_modules/.bin/tsx tools/mainnet-validate/harness/scripts/gen-stateful-fixtures.ts
 *
 * Node target: http://localhost:9053 (testnet, fullHeight ~403k).
 * Indexer target: http://localhost:9054 (testnet).
 *
 * Shapes covered:
 *   - multi-input-10: h=402900, 10 signed inputs — strong multi-input verify path
 *   - multi-input-3:  h=402800, 3 signed inputs — secondary multi-input case
 *
 * Storage-rent (empty-proof spend by demurrage): NOT found on testnet. Testnet
 * only started ~403k blocks ago; STORAGE_PERIOD = 1,051,200 blocks, so no box
 * has aged into rent-eligibility yet. Two ordinary multi-input txs are used per
 * task spec ("note it in your report").
 *
 * preHeader.timestamp is stored as a STRING to guarantee no JS-number precision
 * loss (u64; per project memory "Harness JSON precision rule").
 *
 * parameters: maxBlockCost read from the nearest epoch boundary ≤ height; the
 * remaining consensus parameters use sigma-rust defaults (storageFeeFactor,
 * minValuePerByte, inputCost, dataInputCost, outputCost, tokenAccessCost).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    Transaction,
    UnsignedTransaction,
} from 'ergo-lib-wasm-nodejs';

// --- paths ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const statefulDir = path.join(
    repoRoot,
    'packages', 'transaction', 'test', 'fixtures', 'stateful',
);

const NODE_URL = 'http://localhost:9053';
const INDEXER_URL = 'http://localhost:9054/api/v1';

/** sigma-rust defaults — used for fields the node doesn't expose per-block. */
const SIGMA_RUST_DEFAULTS = {
    storageFeeFactor: 1_250_000,
    minValuePerByte: 360,
    inputCost: 2_000,
    dataInputCost: 100,
    outputCost: 100,
    tokenAccessCost: 100,
};

/** sigma-rust genesis maxBlockCost (Parameters::default()). */
const GENESIS_MAX_BLOCK_COST = 1_000_000;

const VOTING_EPOCH_LENGTH = 1024;

// --- helpers ---

function hexToBytes(h: string): Uint8Array {
    const a = new Uint8Array(h.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return a;
}

function bytesToHex(b: Uint8Array): string {
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    // Use text + JSON.parse. For nBits/timestamp we handle precision separately
    // in the fixture (timestamp stored as string; nBits fits in u32 safely).
    return JSON.parse(await res.text());
}

// --- types ---

interface SpendingProofJson {
    proofBytes: string;
    extension: Record<string, string>;
}

interface InputJson {
    boxId: string;
    spendingProof: SpendingProofJson;
}

interface TxJson {
    id: string;
    inputs: InputJson[];
    dataInputs: { boxId: string }[];
    outputs: { boxId: string; [k: string]: unknown }[];
}

interface BlockHeaderJson {
    id: string;
    version: number;
    parentId: string;
    timestamp: number;
    nBits: number;
    height: number;
    votes: string;
    powSolutions?: { pk: string };
    autolykosSolution?: { minerPk: string };
    [k: string]: unknown;
}

interface BlockJson {
    header: BlockHeaderJson;
    blockTransactions: { transactions: TxJson[] };
}

interface ValidationFragmentsJson {
    headerBytes: string;
    parameters: { maxBlockCost: number } | null;
    transactions: { signingMessage: string }[];
}

interface SpecEntry {
    height: number;
    txId: string;
    note: string;
}

// --- candidate specs ---

// Chosen by scanning testnet recent blocks:
//   multi-input-10  h=402900  dec62f8e…  10 signed inputs — strong multi-input verify
//   multi-input-3   h=402800  8551d5a2…  3 signed inputs — secondary multi-input verify
//
// Storage-rent: NOT found — testnet is only ~403k blocks old; STORAGE_PERIOD is
// 1,051,200 blocks so no box has aged into rent-eligibility. Two ordinary
// multi-input txs are used as allowed by the task spec.
const CANDIDATE_SPECS: SpecEntry[] = [
    {
        height: 402900,
        txId: 'dec62f8ebfdd0b1f12c37f665c4e82c58cafe32ae16210cea125869afcca87d0',
        note: 'multi-input-10',
    },
    {
        height: 402800,
        txId: '8551d5a22ab56b1921fddfcc56a3a473f159803fb76a37929eff85e8116a6917',
        note: 'multi-input-3',
    },
];

// --- tx serialization (mirrors gen-tx-fixtures.ts parseTx) ---

function serializeTx(tx: TxJson): Uint8Array {
    const proofs: Uint8Array[] = tx.inputs.map((inp) => hexToBytes(inp.spendingProof.proofBytes));
    const unsignedObj = {
        inputs: tx.inputs.map((inp) => ({
            boxId: inp.boxId,
            extension: inp.spendingProof.extension,
        })),
        dataInputs: tx.dataInputs,
        outputs: tx.outputs,
    };
    const unsigned = UnsignedTransaction.from_json(JSON.stringify(unsignedObj));
    // from_unsigned_tx moves unsigned — do not call unsigned.free()
    const wasmTx = Transaction.from_unsigned_tx(unsigned, proofs);
    const bytes = wasmTx.sigma_serialize_bytes();
    // Self-check: re-parse and confirm id
    const reparsed = Transaction.sigma_parse_bytes(bytes);
    const reparsedId = reparsed.id().to_str();
    reparsed.free();
    wasmTx.free();
    if (reparsedId !== tx.id) {
        throw new Error(`id mismatch after round-trip: wasm=${reparsedId} node=${tx.id}`);
    }
    return bytes;
}

// --- fetch box canonical bytes from indexer ---

async function fetchBoxBytes(boxId: string): Promise<string> {
    const url = `${INDEXER_URL}/boxes/${boxId}/bytes`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status} (boxId=${boxId})`);
    const data = (await res.json()) as { bytes: string };
    return data.bytes; // hex
}

// --- resolve active maxBlockCost ---

async function resolveMaxBlockCost(height: number): Promise<number> {
    const target = Math.floor(height / VOTING_EPOCH_LENGTH) * VOTING_EPOCH_LENGTH;
    for (let b = target; b >= 0; b -= VOTING_EPOCH_LENGTH) {
        try {
            const ids = (await fetchJson(`${NODE_URL}/blocks/at/${b}`)) as string[];
            if (ids.length > 0) {
                const frags = (await fetchJson(
                    `${NODE_URL}/blocks/${ids[0]!}/validation-fragments`,
                )) as ValidationFragmentsJson;
                if (frags.parameters !== null) {
                    return frags.parameters.maxBlockCost;
                }
            }
        } catch {
            // epoch boundary unavailable, walk back
        }
        if (b === 0) break;
    }
    return GENESIS_MAX_BLOCK_COST;
}

// --- main ---

async function generate(): Promise<void> {
    const info = (await fetchJson(`${NODE_URL}/info`)) as { fullHeight: number; network: string };
    console.log(
        `[gen-stateful-fixtures] node: ${NODE_URL} network=${info.network} fullHeight=${info.fullHeight}`,
    );
    if (info.network !== 'testnet') {
        throw new Error(`Expected testnet, got ${info.network}`);
    }

    fs.mkdirSync(statefulDir, { recursive: true });

    let passed = 0;
    let failed = 0;

    for (const spec of CANDIDATE_SPECS) {
        process.stdout.write(
            `[gen-stateful-fixtures] ${spec.txId.slice(0, 16)}… h=${spec.height} (${spec.note})\n`,
        );

        // Fetch block
        const ids = (await fetchJson(`${NODE_URL}/blocks/at/${spec.height}`)) as string[];
        if (ids.length === 0) {
            console.error(`  SKIP: no header at h=${spec.height}`);
            failed++;
            continue;
        }
        const headerId = ids[0]!;
        const block = (await fetchJson(`${NODE_URL}/blocks/${headerId}`)) as BlockJson;

        const tx = block.blockTransactions.transactions.find((t) => t.id === spec.txId);
        if (tx === undefined) {
            console.error(`  SKIP: tx not found in block`);
            failed++;
            continue;
        }

        // Serialize tx bytes via ergo-lib-wasm
        let txBytes: Uint8Array;
        try {
            txBytes = serializeTx(tx);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  BLOCKED (tx serialize): ${msg}`);
            failed++;
            continue;
        }

        // Fetch spent input box bytes from indexer
        const inputBoxesHex: string[] = [];
        let boxFailed = false;
        for (const inp of tx.inputs) {
            try {
                const hex = await fetchBoxBytes(inp.boxId);
                inputBoxesHex.push(hex);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  BLOCKED (box ${inp.boxId.slice(0, 16)}…): ${msg}`);
                boxFailed = true;
                break;
            }
        }
        if (boxFailed) {
            failed++;
            continue;
        }

        // Fetch data-input box bytes from indexer (may be empty)
        const dataInputBoxesHex: string[] = [];
        let dataBoxFailed = false;
        for (const di of tx.dataInputs) {
            try {
                const hex = await fetchBoxBytes(di.boxId);
                dataInputBoxesHex.push(hex);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  BLOCKED (data-box ${di.boxId.slice(0, 16)}…): ${msg}`);
                dataBoxFailed = true;
                break;
            }
        }
        if (dataBoxFailed) {
            failed++;
            continue;
        }

        // Fetch 10 preceding header bytes (oldest-first heights, then reverse to newest-first)
        // Preceding = headers BEFORE the current block (heights H-10..H-1 inclusive, newest first)
        const firstPrec = Math.max(2, spec.height - 10);
        const lastPrec = spec.height - 1;
        const ascendingHeadersHex: string[] = [];
        let headerFailed = false;
        for (let h = firstPrec; h <= lastPrec; h++) {
            try {
                const hids = (await fetchJson(`${NODE_URL}/blocks/at/${h}`)) as string[];
                if (hids.length === 0) throw new Error(`empty ids at h=${h}`);
                const frags = (await fetchJson(
                    `${NODE_URL}/blocks/${hids[0]!}/validation-fragments`,
                )) as ValidationFragmentsJson;
                ascendingHeadersHex.push(frags.headerBytes);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`  BLOCKED (header h=${h}): ${msg}`);
                headerFailed = true;
                break;
            }
        }
        if (headerFailed) {
            failed++;
            continue;
        }
        // Pad to exactly 10 by repeating the oldest (mirrors Rust tx_validation.rs padding)
        while (ascendingHeadersHex.length < 10) {
            const oldest = ascendingHeadersHex[0];
            if (oldest === undefined) throw new Error('no preceding headers at all');
            ascendingHeadersHex.unshift(oldest);
        }
        // Reverse to newest-first
        const headersHex = ascendingHeadersHex.slice().reverse();

        // Extract preHeader from the current block's header JSON
        const bh = block.header;
        const minerPk = bh.powSolutions?.pk ?? bh.autolykosSolution?.minerPk;
        if (minerPk === undefined) {
            console.error(`  BLOCKED: cannot find minerPk in block header`);
            failed++;
            continue;
        }

        // Resolve active maxBlockCost
        let maxBlockCost: number;
        try {
            maxBlockCost = await resolveMaxBlockCost(spec.height);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  BLOCKED (maxBlockCost): ${msg}`);
            failed++;
            continue;
        }

        // Build fixture JSON
        // NOTE: timestamp stored as STRING to prevent u64 precision loss through
        // JS Number (project memory "Harness JSON precision rule").
        const fixture = {
            id: spec.txId,
            note: spec.note,
            network: 'testnet' as const,
            height: spec.height,
            txBytesHex: bytesToHex(txBytes),
            inputBoxesHex,
            dataInputBoxesHex,
            headersHex,
            preHeader: {
                version: bh.version,
                parentId: bh.parentId,
                timestamp: String(bh.timestamp),
                nBits: bh.nBits,
                height: bh.height,
                minerPk,
                votes: bh.votes,
            },
            parameters: {
                maxBlockCost,
                ...SIGMA_RUST_DEFAULTS,
            },
        };

        const outPath = path.join(statefulDir, `${spec.txId}.json`);
        fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');

        console.log(
            `  OK  ${spec.txId} (txBytes=${txBytes.length}B ` +
            `inputs=${inputBoxesHex.length} dataInputs=${dataInputBoxesHex.length} ` +
            `headers=${headersHex.length} maxBlockCost=${maxBlockCost})`,
        );
        passed++;
    }

    console.log(
        `\n[gen-stateful-fixtures] done: ${passed} fixtures written, ${failed} failed`,
    );
    console.log(`[gen-stateful-fixtures] output dir: ${statefulDir}`);

    if (passed < 2) {
        throw new Error(`Only ${passed} fixtures written (need ≥2); check errors above`);
    }
}

generate().catch((err) => {
    console.error(
        '[gen-stateful-fixtures] FATAL:',
        err instanceof Error ? err.message : err,
    );
    process.exit(1);
});
