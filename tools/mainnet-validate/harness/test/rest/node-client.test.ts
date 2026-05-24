import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NodeClient, NodeRestError } from '../../src/rest/node-client.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'rest');

describe('NodeClient', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
        const blockJson = readFileSync(join(fixtures, 'h2-block.json'), 'utf8');
        const fragmentsJson = readFileSync(join(fixtures, 'h2-validation-fragments.json'), 'utf8');
        const headerIdsJson = readFileSync(join(fixtures, 'h2-headerIds.json'), 'utf8');
        server = createServer((req, res) => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/info') return void res.end(JSON.stringify({ fullHeight: 1791785, bestHeaderId: 'aa'.repeat(32), network: 'mainnet' }));
            if (req.url === '/blocks/at/2') return void res.end(headerIdsJson);
            if (req.url?.startsWith('/blocks/') && req.url.endsWith('/validation-fragments')) return void res.end(fragmentsJson);
            if (req.url?.startsWith('/blocks/00')) { res.statusCode = 404; return void res.end(JSON.stringify({ error: 'block-not-found' })); }
            if (req.url?.startsWith('/blocks/')) return void res.end(blockJson);
            res.statusCode = 404; res.end();
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    });

    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('getInfo', async () => {
        const c = new NodeClient(baseUrl);
        const info = await c.getInfo();
        expect(info.fullHeight).toBe(1791785);
        await c.close();
    });

    it('getHeaderIdsAtHeight', async () => {
        const c = new NodeClient(baseUrl);
        const ids = await c.getHeaderIdsAtHeight(2);
        expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
        await c.close();
    });

    it('getBlock', async () => {
        const c = new NodeClient(baseUrl);
        const b = await c.getBlock('aa'.repeat(32));
        expect(b.header.height).toBe(2);
        await c.close();
    });

    it('getValidationFragments', async () => {
        const c = new NodeClient(baseUrl);
        const f = await c.getValidationFragments('aa'.repeat(32));
        expect(f.headerBytes).toMatch(/^[0-9a-f]+$/);
        await c.close();
    });

    it('throws block-not-found on 404', async () => {
        const c = new NodeClient(baseUrl);
        await expect(c.getBlock('00'.repeat(32))).rejects.toThrowError(NodeRestError);
        await c.close();
    });
});
