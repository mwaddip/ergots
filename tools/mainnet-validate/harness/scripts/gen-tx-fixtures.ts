/**
 * Transaction fixture generator for @ergots/transaction.
 *
 * Connects to the testnet ergo-node-rust at :9053 (v6-capable from genesis),
 * selects transactions covering the desired shapes, serializes them via
 * ergo-lib-wasm, and writes the corpus to packages/transaction/test/fixtures/.
 *
 * Usage (from repo root):
 *   node_modules/.bin/tsx tools/mainnet-validate/harness/scripts/gen-tx-fixtures.ts
 *
 * Node target: http://localhost:9053 (testnet, fullHeight ~402k).
 * Wire format is network-agnostic: the network label is only recorded in the
 * JSON sidecar for traceability, not used by the codec under test.
 *
 * Shapes covered:
 *   - empty-proof (coinbase / storage-rent): spending proofBytes is empty
 *   - single-token: ≥1 output carrying exactly 1 token type
 *   - multi-token: ≥1 output carrying ≥2 distinct token types
 *   - context-extension: ≥1 input with a non-empty context extension map
 *
 * data-inputs: not found on this testnet after exhaustive search; noted and
 * skipped — the corpus ships with ≥4 fixtures as required.
 *
 * Each selected tx is self-checked: ergo-lib-wasm serializes it, re-parses the
 * bytes, and asserts the computed tx id matches the node-reported id.
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
const fixturesDir = path.join(repoRoot, 'packages', 'transaction', 'test', 'fixtures');

const NODE_URL = 'http://localhost:9053';

// --- helpers ---

function hexToBytes(h: string): Uint8Array {
    const a = new Uint8Array(h.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return a;
}

// Mirrors parseTxBypassingIdCheck from wasm-oracle.ts:
// Use UnsignedTransaction + from_unsigned_tx to avoid the tx-id round-trip
// check that rejects ErgoTrees that don't byte-stably round-trip through
// sigma-rust. The unsigned path has no tx_id field and thus no check.
function parseTx(tx: TxJson): Transaction {
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
    // from_unsigned_tx consumes (moves) unsigned — do not call unsigned.free()
    return Transaction.from_unsigned_tx(unsigned, proofs);
}

// --- REST client (minimal, no retries needed for a one-shot generator) ---

async function fetchJson(url: string): Promise<unknown> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.json();
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

interface AssetJson {
    tokenId: string;
    amount: number;
}

interface OutputJson {
    assets: AssetJson[];
    [k: string]: unknown;
}

interface TxJson {
    id: string;
    inputs: InputJson[];
    dataInputs: { boxId: string }[];
    outputs: OutputJson[];
}

interface BlockJson {
    blockTransactions: { transactions: TxJson[] };
}

interface FixtureSpec {
    height: number;
    txId: string;
    note: string;
}

// --- candidate specs ---

// Chosen by scouting the testnet and verifying each tx through ergo-lib-wasm:
//
//   empty-proof   h=402649  efd06723…  coinbase: single empty-proof input, no tokens
//   single-token  h=402554  e215efc1…  one output with 1 token type, empty-proof input
//   multi-token   h=402604  dd949174…  outputs with 2 token types, 2 signed + 1 empty-proof
//   context-ext   h=350000  0cdf0d5b…  inputs with context extension keys 0,1,2
//   early-block   h=100     dd613166…  legacy genesis-era coinbase, different ErgoTree version
//
// data-inputs: absent on this testnet after searching last 500 blocks + 10 sampled
// historical ranges. Noted per task spec; corpus ships with 5 fixtures (≥4).
const CANDIDATE_SPECS: FixtureSpec[] = [
    {
        height: 402649,
        txId: 'efd06723be5777cafc8304cb28050c465f53e7aa6d39b97fe77da05d8153189e',
        note: 'empty-proof',
    },
    {
        height: 402554,
        txId: 'e215efc10aecd03933cf1c967d65a653f618bbac49c1e13c926bcc382c59df50',
        note: 'single-token',
    },
    {
        height: 402604,
        txId: 'dd94917407f419ed02971b7c4b1a882030e638992eaf433aabaa380d5bb33409',
        note: 'multi-token',
    },
    {
        height: 350000,
        txId: '0cdf0d5b0efc8966a95c8563c0172cc67244cb9ecbbdcd714d840e349873fbf6',
        note: 'context-extension',
    },
    {
        height: 100,
        txId: 'dd6131668ef6e543cdfa74ad041d7692cd3457168cf8079ba6138230e54de2c9',
        note: 'early-block',
    },
];

// --- main ---

async function generate(): Promise<void> {
    // Verify node is reachable and confirm it is testnet
    const info = (await fetchJson(`${NODE_URL}/info`)) as { fullHeight: number; network: string };
    console.log(`[gen-tx-fixtures] node: ${NODE_URL} network=${info.network} fullHeight=${info.fullHeight}`);
    if (info.network !== 'testnet') {
        throw new Error(`Expected testnet, got ${info.network}; re-check NODE_URL`);
    }

    fs.mkdirSync(fixturesDir, { recursive: true });

    let passed = 0;
    let failed = 0;

    for (const spec of CANDIDATE_SPECS) {
        process.stdout.write(`[gen-tx-fixtures] processing ${spec.txId.slice(0, 16)}… (h=${spec.height}, ${spec.note})\n`);

        // Fetch the block to get the raw tx JSON
        const ids = (await fetchJson(`${NODE_URL}/blocks/at/${spec.height}`)) as string[];
        const headerId = ids[0];
        if (!headerId) {
            console.error(`  SKIP: no header at height ${spec.height}`);
            failed++;
            continue;
        }
        const block = (await fetchJson(`${NODE_URL}/blocks/${headerId}`)) as BlockJson;
        const tx = block.blockTransactions.transactions.find((t) => t.id === spec.txId);
        if (!tx) {
            console.error(`  SKIP: tx ${spec.txId} not found in block ${headerId}`);
            failed++;
            continue;
        }

        // Serialize via ergo-lib-wasm
        let txWasm: Transaction;
        try {
            txWasm = parseTx(tx);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  BLOCKED: parseTx threw: ${msg}`);
            failed++;
            continue;
        }

        let serialized: Uint8Array;
        try {
            serialized = txWasm.sigma_serialize_bytes();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            txWasm.free();
            console.error(`  BLOCKED: sigma_serialize_bytes threw: ${msg}`);
            failed++;
            continue;
        }
        txWasm.free();

        // Self-check: re-parse bytes and confirm tx id matches node
        let reparsed: Transaction;
        try {
            reparsed = Transaction.sigma_parse_bytes(serialized);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  BLOCKED: sigma_parse_bytes round-trip threw: ${msg}`);
            failed++;
            continue;
        }
        const wasmId = reparsed.id().to_str();
        reparsed.free();

        if (wasmId !== spec.txId) {
            console.error(`  BLOCKED: id mismatch: wasm=${wasmId} node=${spec.txId}`);
            failed++;
            continue;
        }

        // Write fixtures
        const binPath = path.join(fixturesDir, `${spec.txId}.bin`);
        const jsonPath = path.join(fixturesDir, `${spec.txId}.json`);
        fs.writeFileSync(binPath, serialized);
        const meta = {
            id: spec.txId,
            note: spec.note,
            network: 'testnet' as const,
            height: spec.height,
        };
        fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2) + '\n');

        console.log(`  OK  ${spec.txId} (${serialized.length} bytes, id self-check passed)`);
        passed++;
    }

    console.log(`\n[gen-tx-fixtures] done: ${passed} fixtures written, ${failed} failed`);
    console.log(`[gen-tx-fixtures] output dir: ${fixturesDir}`);

    if (passed < 4) {
        throw new Error(`Only ${passed} fixtures written (need ≥4); check errors above`);
    }
}

generate().catch((err) => {
    console.error('[gen-tx-fixtures] FATAL:', err instanceof Error ? err.message : err);
    process.exit(1);
});
