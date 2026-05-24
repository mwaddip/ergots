/**
 * HTTP client for the ergo-node indexer addon REST surface at
 * :9054/api/v1. Single undici Agent reused across calls.
 *
 * Mandatory blake2b256(serverBytes) === boxId cross-check on every box
 * fetch (per spec §3.2). Even though the indexer hash-verifies before
 * serving, the harness recomputes defensively per [[feedback-
 * correctness-over-effort]]. Mismatch => IndexerRestError with code
 * 'box-hash-mismatch'.
 */

import { Agent, fetch as undiciFetch } from 'undici';
import { blake2b } from '@noble/hashes/blake2.js';
import { parseBoxBytesResponse } from './types.js';

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

    constructor(private readonly baseUrl: string) {
        this.agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });
    }

    /**
     * Fetch canonical ErgoBox bytes by id. Verifies blake2b256(bytes) === boxId
     * before returning; throws IndexerRestError('box-hash-mismatch') on disagreement.
     */
    async getBoxBytes(boxId: string): Promise<Uint8Array> {
        if (!/^[0-9a-f]{64}$/.test(boxId)) {
            throw new IndexerRestError('unexpected-status', `boxId must be 64-hex-char, got ${boxId}`);
        }
        const raw = await this.fetchJson(`/boxes/${boxId}/bytes`, 'box-bytes', {
            404: () => new IndexerRestError('box-not-found', `box ${boxId} not in indexer`, 404),
        });
        const parsed = parseBoxBytesResponse(raw);
        const bytes = hexDecode(parsed.bytes);
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
                const url = `${this.baseUrl}${path}`;
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
