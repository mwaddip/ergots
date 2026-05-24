/**
 * HTTP client for the ergo-node indexer addon REST surface at
 * :9054/api/v1. Single undici Agent reused across calls.
 *
 * Mandatory blake2b256(serverBytes) === boxId cross-check on every box
 * fetch (per spec §3.2). Even though the indexer hash-verifies before
 * serving, the harness recomputes defensively per [[feedback-
 * correctness-over-effort]]. Mismatch => IndexerRestError with code
 * 'box-hash-mismatch'.
 *
 * # Genesis-state box fallback
 *
 * Ergo's genesis UTXO state includes 3 boxes that were never outputs of any
 * block transaction — they are defined in the genesis configuration and
 * injected into the initial AVL+ UTXO tree at startup. The indexer does not
 * index these boxes (it only indexes transaction outputs). When a block spends
 * a genesis-state box (e.g. the founders treasury renewal at h=3850), the
 * indexer returns 404. The harness recovers by serving these boxes from a
 * hardcoded table. The bytes here are the canonical bytes produced by
 * `build_genesis_boxes(Mainnet)` in ergo-node-rust src/main.rs; they are
 * deterministic (derived from MonetarySettings::default() + FOUNDERS_PKS).
 * The blake2b256 cross-check in getBoxBytes() verifies each byte on every
 * use — the fallback cannot silently serve wrong bytes.
 *
 * Source: ergo-node-rust/src/main.rs tests::mainnet_genesis_boxes_produce_correct_digest
 * (commit a5d2b51a on integration/ergots branch, extracted 2026-05-24)
 */

import { Agent, fetch as undiciFetch } from 'undici';
import { blake2b } from '@noble/hashes/blake2.js';
import { parseBoxBytesResponse } from './types.js';

/**
 * Mainnet genesis-state boxes that the indexer cannot serve (never tx outputs).
 * Key = 64-hex boxId; value = canonical sigma-serialised box bytes (hex).
 * All 3 entries are validated by blake2b256(bytes) === boxId in getBoxBytes().
 */
const MAINNET_GENESIS_BOXES: ReadonlyMap<string, string> = new Map([
    // Emission box (box[0]): spent at h=1 genesis tx
    [
        'b69575e11c5c43400bfead5976ee0d6245a1168396b2e2a4f384691f275d501c',
        '80bac28bc7e3f6a501101004020e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a7017300730110010204020404040004c0fd4f05808c82f5f6030580b8c9e5ae040580f882ad16040204c0944004c0f407040004000580f882ad16d19683030191a38cc7a7019683020193c2b2a57300007473017302830108cdeeac93a38cc7b2a573030001978302019683040193b1a5730493c2a7c2b2a573050093958fa3730673079973089c73097e9a730a9d99a3730b730c0599c1a7c1b2a5730d00938cc7b2a5730e0001a390c1a7730f000000000000000000000000000000000000000000000000000000000000000000000000',
    ],
    // No-premine box (box[1]): mainnet-specific (different proof strings than testnet)
    [
        'b8ce8cfe331e5eadfb0783bdc375c94413433f65e1e45857d71550d42e4d83bd',
        '8094ebdc0310010100d173000000050e40303030303030303030303030303030303030313463326532653765333364353161653765363666366363623639343263333433373132376233366333333734370e423078643037613937323933343638643931333263356132616461623265353261323330303965363739383630386534376230643236323363376533653932333436330e464272657869743a20626f746820546f727920736964657320706c617920646f776e207269736b206f66206e6f2d6465616c20616674657220627573696e65737320616c61726d0e54e8bfb0e8af84efbc9ae5b9b3e8a1a1e38081e68c81e7bbade38081e58c85e5aeb9e28094e28094e696b0e697b6e4bba3e5ba94e5afb9e585a8e79083e58c96e68c91e68898e79a84e4b8ade59bbde4b98be981930e45d094d0b8d0b2d0b8d0b4d0b5d0bdd0b4d18b20d0a7d0a2d09fd09720d0b2d18bd180d0b0d181d182d183d18220d0bdd0b02033332520d0bdd0b020d0b0d0bad186d0b8d18e000000000000000000000000000000000000000000000000000000000000000000',
    ],
    // Founders treasury box (box[2]): spent at h=3850 (first treasury renewal)
    [
        '5527430474b673e4aafb08e0079c639de23e6a17e87edd00f78662b43c88aeda',
        '80d6d0c7cfdad807100e040004c094400580809cde91e7b0010580acc7f03704be944004808948058080c7b7e4992c0580b4c4c32104fe884804c0fd4f0580bcc1960b04befd4f05000400ea03d192c1b2a5730000958fa373019a73029c73037e997304a305958fa373059a73069c73077e997308a305958fa373099c730a7e99730ba305730cd193c2a7c2b2a5730d00d50408000000010e6f98040483030808cd039bb5fe52359a64c99a60fd944fc5e388cbdc4d37ff091cc841c3ee79060b864708cd031fb52cf6e805f80d97cde289f4f757d49accf0c83fb864b27d2cf982c37f9a8b08cd0352ac2a471339b0d23b3d2c5ce0db0e81c969f77891b9edf0bda7fd39a78184e7000000000000000000000000000000000000000000000000000000000000000000',
    ],
]);

export type IndexerRestErrorCode =
    | 'box-not-found' | 'box-hash-mismatch' | 'indexer-internal-error'
    | 'network-error' | 'unexpected-status';

export class IndexerRestError extends Error {
    constructor(
        public readonly code: IndexerRestErrorCode,
        message: string,
        public readonly httpStatus?: number,
    ) {
        super(message);
        this.name = 'IndexerRestError';
    }
}

const TIMEOUT_MS = 30_000;
const RETRY_DELAYS: [number, number, number] = [250, 500, 1000];

function hexDecode(s: string): Uint8Array {
    if (s.length % 2 !== 0) throw new Error('hex string odd length');
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function hex(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
    return s;
}

export class IndexerClient {
    private readonly agent: Agent;
    /** Full API base including the /api/v1 path prefix used by the indexer. */
    private readonly apiBase: string;

    constructor(baseUrl: string) {
        // Strip any trailing slash so path concatenation is always "base + /foo".
        const normalized = baseUrl.replace(/\/$/, '');
        this.apiBase = `${normalized}/api/v1`;
        this.agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });
    }

    /**
     * Fetch canonical ErgoBox bytes by id. Verifies blake2b256(bytes) === boxId
     * before returning; throws IndexerRestError('box-hash-mismatch') on disagreement.
     *
     * Falls back to MAINNET_GENESIS_BOXES for the 3 genesis-state boxes that the
     * indexer cannot serve (they were never transaction outputs). The blake2b256
     * cross-check is still performed on every fallback hit — the fallback cannot
     * silently serve wrong bytes.
     */
    async getBoxBytes(boxId: string): Promise<Uint8Array> {
        if (!/^[0-9a-f]{64}$/.test(boxId)) {
            throw new IndexerRestError('unexpected-status', `boxId must be 64-hex-char, got ${boxId}`);
        }
        let boxHex: string | undefined;
        const genesisHex = MAINNET_GENESIS_BOXES.get(boxId);
        if (genesisHex !== undefined) {
            // Genesis-state box: serve from hardcoded table (indexer doesn't index these).
            boxHex = genesisHex;
        } else {
            const raw = await this.fetchJson(`/boxes/${boxId}/bytes`, 'box-bytes', {
                404: () => new IndexerRestError('box-not-found', `box ${boxId} not in indexer`, 404),
            });
            const parsed = parseBoxBytesResponse(raw);
            boxHex = parsed.bytes;
        }
        const bytes = hexDecode(boxHex);
        const computed = hex(blake2b(bytes, { dkLen: 32 }));
        if (computed !== boxId) {
            throw new IndexerRestError(
                'box-hash-mismatch',
                `blake2b256(serverBytes)=${computed} but requested boxId=${boxId}`,
            );
        }
        return bytes;
    }

    async close(): Promise<void> {
        await this.agent.close();
    }

    private async fetchJson(
        path: string,
        op: string,
        overrides: Partial<Record<number, () => IndexerRestError>> = {},
    ): Promise<unknown> {
        for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
            try {
                const url = `${this.apiBase}${path}`;
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
                let res;
                try {
                    res = await undiciFetch(url, { dispatcher: this.agent, signal: ctrl.signal });
                } finally {
                    clearTimeout(t);
                }
                if (res.status >= 200 && res.status < 300) return await res.json();
                const o = overrides[res.status];
                if (o) throw o();
                if (res.status >= 500) {
                    let body = '';
                    try { body = await res.text(); } catch { /* ignore */ }
                    throw new IndexerRestError(
                        'indexer-internal-error',
                        `${op}: ${res.status} — ${body.slice(0, 500)}`,
                        res.status,
                    );
                }
                throw new IndexerRestError('unexpected-status', `${op}: ${res.status}`, res.status);
            } catch (err) {
                if (err instanceof IndexerRestError) throw err;
                if (attempt < RETRY_DELAYS.length) {
                    const delay = RETRY_DELAYS[attempt] ?? 1000;
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                const m = err instanceof Error ? err.message : String(err);
                throw new IndexerRestError('network-error', `${op} after ${attempt + 1}: ${m}`);
            }
        }
        throw new Error('unreachable');
    }
}
