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
 * IndexerClient internally appends `/api/v1` to the base URL passed by
 * the caller. We pass `--indexer-url http://127.0.0.1:${port}` (bare
 * host+port), and the client constructs `${port}/api/v1/boxes/{id}/bytes`,
 * matching the route pattern below.
 *
 * # The ids mode (`--mode ids`)
 *
 * The ids mode parses each transaction from the validation-fragments `bytes`,
 * which the captured fixtures predate. Every input at h=2..h=10 spends the
 * emission box with an empty proof and no extension, so each transaction's
 * bytes equal its signing message: with `serveTxBytes` set, the mock serves
 * the signing message as `bytes`. `tamperTxIdAt` makes the block at that
 * height report a different transaction id, so only an ids check halts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
    /** Serve each transaction's signing message as its `bytes` (see the ids-mode note). */
    let serveTxBytes = false;
    /** Report a different transaction id for the block at this height. */
    let tamperTxIdAt: number | null = null;

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
                        const text = readFileSync(join(fixtures, `h${h}-validation-fragments.json`), 'utf8');
                        if (!serveTxBytes) return void res.end(text);
                        // Only hex strings and small integers here, so a JSON round-trip is lossless.
                        const frags = JSON.parse(text) as { transactions: Array<{ signingMessage: string; bytes?: string }> };
                        for (const t of frags.transactions) t.bytes = t.signingMessage;
                        return void res.end(JSON.stringify(frags));
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
                        const text = readFileSync(join(fixtures, `h${h}-block.json`), 'utf8');
                        if (tamperTxIdAt !== h) return void res.end(text);
                        // A text edit, not a JSON round-trip: box values exceed 2^53. The
                        // outputs name their transaction in "transactionId", which the
                        // pattern does not match, so only the transaction's own id changes.
                        const txId = (JSON.parse(text) as { blockTransactions: { transactions: Array<{ id: string }> } })
                            .blockTransactions.transactions[0]!.id;
                        const other = `${txId[0] === '0' ? '1' : '0'}${txId.slice(1)}`;
                        const tampered = text.replace(`"id":"${txId}"`, `"id":"${other}"`);
                        if (tampered === text) throw new Error(`no "id":"${txId}" in h${h}-block.json`);
                        return void res.end(tampered);
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
            '--indexer-url', `http://127.0.0.1:${port}`,
            '--checkpoint-path', checkpoint,
            '--error-report-path', errorReport,
            '--start-height', '2',
            '--max-height', '10',
        ]);
        expect(code).toBe(0);
    }, 60_000);  // generous timeout — WASM init takes a few seconds on first call

    describe('--mode ids', () => {
        beforeEach(() => {
            serveTxBytes = true;
            tamperTxIdAt = null;
        });

        afterEach(() => {
            serveTxBytes = false;
            tamperTxIdAt = null;
        });

        /** Runs an ids-mode walk of h=2..h=10 in a fresh directory with a census file. */
        async function idsWalk(expected: unknown[]): Promise<{ code: number; dir: string; census: string }> {
            const dir = mkdtempSync(join(tmpDir, 'ids-'));
            const census = join(dir, 'census-expected.json');
            writeFileSync(census, JSON.stringify(expected));
            const code = await main([
                '--node-url', `http://127.0.0.1:${port}`,
                '--indexer-url', `http://127.0.0.1:${port}`,
                '--checkpoint-path', join(dir, 'checkpoint.json'),
                '--error-report-path', join(dir, 'error-report.json'),
                '--start-height', '2',
                '--max-height', '10',
                '--mode', 'ids',
                '--census', census,
            ]);
            return { code, dir, census };
        }

        function errorReportIn(dir: string): { height: number; phase: string; errorCode?: string } {
            return JSON.parse(readFileSync(join(dir, 'error-report.json'), 'utf8'));
        }

        it('walks h=2..h=10: every tx id and output box matches, no tree degrades', async () => {
            const { code, census } = await idsWalk([]);
            expect(code).toBe(0);
            expect(existsSync(`${census}.observed.jsonl`)).toBe(false);
        }, 60_000);

        it('checks the transaction id: a block reporting another id halts', async () => {
            tamperTxIdAt = 5;
            const { code, dir } = await idsWalk([]);
            expect(code).toBe(1);
            expect(errorReportIn(dir)).toMatchObject({ height: 5, phase: 'ids', errorCode: 'tx-id-mismatch' });
        }, 60_000);

        it('keeps the census: a listed degrade that does not happen halts', async () => {
            const { code, dir } = await idsWalk([
                { height: 3, txIndex: 0, outputIndex: 0, reason: 'none: this output is honest' },
            ]);
            expect(code).toBe(1);
            expect(errorReportIn(dir)).toMatchObject({
                height: 3,
                phase: 'census',
                errorCode: 'census-expected-degrade-missing',
            });
        }, 60_000);

        describe('resume safety: a walk keeps its mode and census, and its checkpoint', () => {
            /** Runs `main` against the mock server with `dir`'s checkpoint and error report. */
            function run(dir: string, args: string[]): Promise<number> {
                return main([
                    '--node-url', `http://127.0.0.1:${port}`,
                    '--indexer-url', `http://127.0.0.1:${port}`,
                    '--checkpoint-path', join(dir, 'checkpoint.json'),
                    '--error-report-path', join(dir, 'error-report.json'),
                    ...args,
                ]);
            }

            /** A fresh directory holding a census expected file with `entries`. */
            function walkDir(entries: unknown[] = []): { dir: string; census: string } {
                const dir = mkdtempSync(join(tmpDir, 'resume-'));
                const census = join(dir, 'census-expected.json');
                writeFileSync(census, JSON.stringify(entries));
                return { dir, census };
            }

            /** A checkpoint as the T7 oracle walk left one: written before `mode` and `census` existed. */
            const LEGACY_CHECKPOINT = `${JSON.stringify({
                lastValidatedHeight: 5,
                tipHeightAtStart: 10,
                lastValidatedAt: '2026-05-31T15:40:03.844Z',
                nodeUrl: 'http://localhost:9052',
                indexerUrl: 'http://localhost:9054',
                libraryVersions: { scorex: '0.1.0', nipopow: '0.2.0', avltree: '0.2.0', ergoscript: '0.2.0' },
                stats: {
                    totalBlocks: 4, totalTxs: 4, totalBoxesValidated: 12, totalSpendsValidated: 4,
                    startedAt: '2026-05-27T15:45:00.000Z', elapsedMs: 1000,
                },
                tipReachedAt: '2026-05-31T15:40:03.844Z',
            }, null, 2)}\n`;

            it('refuses to resume a legacy checkpoint (an oracle walk) in ids mode', async () => {
                const { dir, census } = walkDir();
                writeFileSync(join(dir, 'checkpoint.json'), LEGACY_CHECKPOINT);
                expect(await run(dir, ['--mode', 'ids', '--census', census])).toBe(1);
                expect(readFileSync(join(dir, 'checkpoint.json'), 'utf8')).toBe(LEGACY_CHECKPOINT);
                expect(existsSync(join(dir, 'error-report.json'))).toBe(false);
            }, 60_000);

            it('refuses to start a new walk over an existing checkpoint', async () => {
                const { dir, census } = walkDir();
                writeFileSync(join(dir, 'checkpoint.json'), LEGACY_CHECKPOINT);
                const code = await run(dir, ['--start-height', '2', '--max-height', '10', '--mode', 'ids', '--census', census]);
                expect(code).toBe(1);
                expect(readFileSync(join(dir, 'checkpoint.json'), 'utf8')).toBe(LEGACY_CHECKPOINT);
            }, 60_000);

            it('records the walk in its checkpoint, and a resume must keep its mode and census', async () => {
                const { dir, census } = walkDir();
                const checkpointPath = join(dir, 'checkpoint.json');
                expect(await run(dir, ['--start-height', '2', '--max-height', '5', '--mode', 'ids', '--census', census])).toBe(0);
                const walked = readFileSync(checkpointPath, 'utf8');
                expect(JSON.parse(walked)).toMatchObject({ lastValidatedHeight: 5, mode: 'ids', census });

                // Halt → edit → resume must not change the walk's checks: another
                // census, another mode (these two runs change one each), or both.
                const otherCensus = join(dir, 'other-census.json');
                writeFileSync(otherCensus, '[]');
                expect(await run(dir, ['--max-height', '10', '--mode', 'ids', '--census', otherCensus])).toBe(1);
                expect(await run(dir, ['--max-height', '10', '--mode', 'oracle', '--census', census])).toBe(1);
                expect(await run(dir, ['--max-height', '10', '--mode', 'lib'])).toBe(1);
                expect(await run(dir, ['--max-height', '10'])).toBe(1); // oracle, no census
                // Nor may a new walk replace it, even one with the same mode and census.
                expect(await run(dir, ['--start-height', '2', '--max-height', '10', '--mode', 'ids', '--census', census])).toBe(1);
                expect(readFileSync(checkpointPath, 'utf8')).toBe(walked);

                // The same mode and census resume the walk where it stopped.
                expect(await run(dir, ['--max-height', '10', '--mode', 'ids', '--census', census])).toBe(0);
                expect(JSON.parse(readFileSync(checkpointPath, 'utf8'))).toMatchObject({ lastValidatedHeight: 10, mode: 'ids', census });
            }, 60_000);

            it('names the census and its size when a walk starts', async () => {
                const { dir, census } = walkDir([{ height: 100_000, txIndex: 0, outputIndex: 0, reason: 'outside this walk' }]);
                const written: string[] = [];
                const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
                    written.push(String(chunk));
                    return true;
                }) as typeof process.stdout.write);
                let code: number;
                try {
                    code = await run(dir, ['--start-height', '2', '--max-height', '3', '--mode', 'ids', '--census', census]);
                } finally {
                    spy.mockRestore();
                }
                expect(code).toBe(0);
                expect(written.join('')).toContain(`Walking 2..3 (tip=10, network=mainnet, mode=ids, census=${census} (1 expected))`);
            }, 60_000);
        });
    });
});
