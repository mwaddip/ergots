/**
 * End-to-end test walking h=2..h=10 against a mock REST server replaying
 * captured fixtures. Drives the full pipeline (NodeClient + IndexerClient
 * + WasmCostOracle + BundleAssembler + validateBlock).
 *
 * The mock server (Node http.Server on a random port) replays fixture JSON
 * files captured from the live ergo-node (9052) + indexer (9054) at the
 * time this test was written. No live network access required.
 *
 * Per PLAN-2j-rest.md T14 + spec §7.2.
 *
 * # Genesis-emission-box note (h=2 input)
 *
 * The input at h=2 is box `71bc9534...` — the genesis emission box from h=1.
 * Unlike most boxes, this one IS present in the indexer (we confirmed it
 * returns bytes at the live indexer). It is captured as
 * `test/fixtures/rest/box-71bc9534....json`. No special-casing needed.
 *
 * # IndexerClient URL convention
 *
 * IndexerClient constructs paths as `${baseUrl}/boxes/${boxId}/bytes`.
 * We pass `--indexer-url http://127.0.0.1:${port}/api/v1` so the mock
 * receives `/api/v1/boxes/{id}/bytes`, matching the route pattern below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../src/main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// test/integration -> test -> harness
const fixtures = join(HERE, '..', 'fixtures', 'rest');

describe('mock-REST walk h=2..h=10', () => {
    let server: Server;
    let port: number;
    let tmpDir: string;

    beforeAll(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), 'ergots-mock-rest-'));
        server = createServer((req, res) => {
            res.setHeader('content-type', 'application/json');

            // /info — pretend tip is h=10
            if (req.url === '/info') {
                return void res.end(JSON.stringify({
                    fullHeight: 10,
                    bestHeaderId: 'aa'.repeat(32),
                    network: 'mainnet',
                }));
            }

            // /blocks/at/{h}
            const atMatch = req.url?.match(/^\/blocks\/at\/(\d+)$/);
            if (atMatch) {
                const path = join(fixtures, `h${atMatch[1]}-headerIds.json`);
                if (existsSync(path)) return void res.end(readFileSync(path, 'utf8'));
                res.statusCode = 404;
                return void res.end('[]');
            }

            // /blocks/{id}/validation-fragments (must be checked before /blocks/{id})
            const fragMatch = req.url?.match(/^\/blocks\/([0-9a-f]{64})\/validation-fragments$/);
            if (fragMatch) {
                const headerId = fragMatch[1];
                for (let h = 2; h <= 10; h++) {
                    const idsPath = join(fixtures, `h${h}-headerIds.json`);
                    if (!existsSync(idsPath)) continue;
                    const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as string[];
                    if (ids[0] === headerId) {
                        return void res.end(readFileSync(join(fixtures, `h${h}-validation-fragments.json`), 'utf8'));
                    }
                }
                res.statusCode = 404;
                return void res.end(JSON.stringify({ error: 'fragments-not-found', headerId }));
            }

            // /blocks/{id}
            const blockMatch = req.url?.match(/^\/blocks\/([0-9a-f]{64})$/);
            if (blockMatch) {
                const headerId = blockMatch[1];
                for (let h = 2; h <= 10; h++) {
                    const idsPath = join(fixtures, `h${h}-headerIds.json`);
                    if (!existsSync(idsPath)) continue;
                    const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as string[];
                    if (ids[0] === headerId) {
                        return void res.end(readFileSync(join(fixtures, `h${h}-block.json`), 'utf8'));
                    }
                }
                res.statusCode = 404;
                return void res.end(JSON.stringify({ error: 'block-not-found', headerId }));
            }

            // /api/v1/boxes/{id}/bytes  (indexer path; baseUrl includes /api/v1)
            const boxMatch = req.url?.match(/^\/api\/v1\/boxes\/([0-9a-f]{64})\/bytes$/);
            if (boxMatch) {
                const boxId = boxMatch[1];
                const path = join(fixtures, `box-${boxId}.json`);
                if (existsSync(path)) return void res.end(readFileSync(path, 'utf8'));
                res.statusCode = 404;
                return void res.end(JSON.stringify({ error: 'box-not-found', boxId }));
            }

            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'unmatched-route', url: req.url }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        port = (server.address() as { port: number }).port;
    });

    afterAll(() => new Promise<void>((resolve) => {
        server.close(() => {
            rmSync(tmpDir, { recursive: true, force: true });
            resolve();
        });
    }));

    it('walks h=2..h=10 with no halt', async () => {
        const checkpoint = join(tmpDir, 'checkpoint.json');
        const errorReport = join(tmpDir, 'error-report.json');
        const code = await main([
            '--node-url', `http://127.0.0.1:${port}`,
            '--indexer-url', `http://127.0.0.1:${port}/api/v1`,
            '--checkpoint-path', checkpoint,
            '--error-report-path', errorReport,
            '--start-height', '2',
            '--max-height', '10',
        ]);
        expect(code).toBe(0);
    }, 60_000);  // generous timeout — WASM init takes a few seconds on first call
});
