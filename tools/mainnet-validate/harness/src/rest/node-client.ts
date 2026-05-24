/**
 * HTTP client for the ergo-node REST surface at :9052. Single undici
 * Agent reused across calls so HTTP/1.1 keep-alive amortizes connection
 * cost over a 1M-block walk. 30s timeout, 3 retries with exp backoff
 * (250ms, 500ms, 1s). Halt on persistent failure (no skip-and-continue).
 *
 * Error taxonomy per spec §5:
 *   - block-not-found, block-pruned: structured upstream errors
 *   - fragments-not-available, fragments-malformed: validation-fragments
 *     endpoint-specific
 *   - node-internal-error: 5xx with structured payload
 *   - network-error: fetch failure, timeout, abort
 *   - unexpected-status: 4xx that doesn't map to a specific code
 */

import { Agent, fetch as undiciFetch } from 'undici';
import {
    parseInfoResponse, parseHeaderIdsAtHeightResponse,
    parseBlockResponse, parseValidationFragmentsResponse,
    type InfoResponse, type HeaderIdsAtHeightResponse,
    type BlockResponse, type ValidationFragmentsResponse,
} from './types.js';
import { parseLossless } from './json-bigint.js';

export type NodeRestErrorCode =
    | 'block-not-found' | 'block-pruned' | 'fragments-not-available'
    | 'fragments-malformed' | 'node-internal-error' | 'network-error' | 'unexpected-status';

export class NodeRestError extends Error {
    constructor(
        public readonly code: NodeRestErrorCode,
        message: string,
        public readonly httpStatus?: number,
    ) {
        super(message);
        this.name = 'NodeRestError';
    }
}

const TIMEOUT_MS = 30_000;
const RETRY_DELAYS: [number, number, number] = [250, 500, 1000];

export class NodeClient {
    private readonly agent: Agent;

    constructor(private readonly baseUrl: string) {
        this.agent = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });
    }

    async getInfo(): Promise<InfoResponse> {
        return parseInfoResponse(await this.fetchJson('/info', 'info'));
    }

    async getHeaderIdsAtHeight(height: number): Promise<HeaderIdsAtHeightResponse> {
        return parseHeaderIdsAtHeightResponse(await this.fetchJson(`/blocks/at/${height}`, 'header-ids'));
    }

    async getBlock(headerId: string): Promise<BlockResponse> {
        const raw = await this.fetchJson(`/blocks/${headerId}`, 'block', {
            404: () => new NodeRestError('block-not-found', `block ${headerId} not found`, 404),
        });
        return parseBlockResponse(raw);
    }

    async getValidationFragments(headerId: string): Promise<ValidationFragmentsResponse> {
        const raw = await this.fetchJson(`/blocks/${headerId}/validation-fragments`, 'fragments', {
            404: () => new NodeRestError('fragments-not-available', `validation-fragments for ${headerId} not found`, 404),
        });
        try {
            return parseValidationFragmentsResponse(raw);
        } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            throw new NodeRestError('fragments-malformed', m);
        }
    }

    async close(): Promise<void> {
        await this.agent.close();
    }

    private async fetchJson(
        path: string,
        op: string,
        overrides: Partial<Record<number, () => NodeRestError>> = {},
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
                if (res.status >= 200 && res.status < 300) return parseLossless(await res.text());
                const o = overrides[res.status];
                if (o) throw o();
                if (res.status === 410) throw new NodeRestError('block-pruned', `${op}: 410`, 410);
                if (res.status >= 500) {
                    let body = '';
                    try { body = await res.text(); } catch { /* ignore */ }
                    throw new NodeRestError(
                        'node-internal-error',
                        `${op}: ${res.status} — ${body.slice(0, 500)}`,
                        res.status,
                    );
                }
                throw new NodeRestError('unexpected-status', `${op}: ${res.status}`, res.status);
            } catch (err) {
                if (err instanceof NodeRestError) throw err;
                if (attempt < RETRY_DELAYS.length) {
                    const delay = RETRY_DELAYS[attempt] ?? 1000;
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                const m = err instanceof Error ? err.message : String(err);
                throw new NodeRestError('network-error', `${op} after ${attempt + 1}: ${m}`);
            }
        }
        throw new Error('unreachable');
    }
}
