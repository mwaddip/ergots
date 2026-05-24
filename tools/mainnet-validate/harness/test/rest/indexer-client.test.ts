import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { blake2b } from '@noble/hashes/blake2.js';
import { IndexerClient, IndexerRestError } from '../../src/rest/indexer-client.js';

function hex(b: Uint8Array): string { return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(''); }

describe('IndexerClient', () => {
    let server: Server;
    let baseUrl: string;
    const fakeBoxBytes = new Uint8Array(64).fill(0xab);
    const fakeBoxId = hex(blake2b(fakeBoxBytes, { dkLen: 32 }));

    beforeAll(async () => {
        server = createServer((req, res) => {
            const m = req.url?.match(/^\/api\/v1\/boxes\/([0-9a-f]{64})\/bytes$/);
            if (!m) { res.statusCode = 404; res.end(); return; }
            res.setHeader('content-type', 'application/json');
            const id = m[1]!;
            if (id === fakeBoxId) return void res.end(JSON.stringify({ bytes: hex(fakeBoxBytes) }));
            if (id === '11'.repeat(32)) return void res.end(JSON.stringify({ bytes: 'deadbeef' }));  // mismatch
            res.statusCode = 404; res.end(JSON.stringify({ error: 'box-not-found', boxId: id }));
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
    });

    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('returns bytes that hash to requested id', async () => {
        const c = new IndexerClient(baseUrl);
        const bytes = await c.getBoxBytes(fakeBoxId);
        expect(hex(bytes)).toBe(hex(fakeBoxBytes));
        await c.close();
    });

    it('throws box-hash-mismatch on disagreement', async () => {
        const c = new IndexerClient(baseUrl);
        await expect(c.getBoxBytes('11'.repeat(32))).rejects.toThrowError(IndexerRestError);
        await c.close();
    });

    it('throws box-not-found on 404', async () => {
        const c = new IndexerClient(baseUrl);
        await expect(c.getBoxBytes('00'.repeat(32))).rejects.toThrowError(IndexerRestError);
        await c.close();
    });
});
