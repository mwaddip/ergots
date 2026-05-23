/**
 * Integration test: harness halt path + clean-walk path (Layer 4 of the
 * mainnet-validate spec).
 *
 * Two scenarios are exercised here as separate `it(...)` cases:
 *
 *   1. **Startup halt** — the shim's initial `GET_TIP_HEIGHT` call fails
 *      (here: the shim is pointed at a fresh empty redb path it
 *      auto-creates, then trips its "store has no Headers" prerequisite
 *      check). The failure surfaces from `await shim.getTipHeight()` in
 *      `main.ts` line 369, which sits in the OUTER try block whose catch
 *      arm writes only to stderr — NO `error-report.json` is produced.
 *      This is by design per `main.ts` lines 467-477: error-report is
 *      reserved for per-block fetch / validation failures with a known
 *      height, not for setup failures with no height context.
 *
 *   2. **Clean tip-reach** — a short walk against the real bootstrap-data
 *      snapshot that completes without halting. After phase 2j-pre fix-3
 *      (Or/Xor/Atleast exprTpe arms RESOLVED 2026-05-22), the harness
 *      walks heights 1..10000 cleanly (per the fix-3 Layer-3 smoke
 *      findings). The test caps `--max-height` at 50 to keep CI under
 *      1s; verifies exit code 0, `tipReachedAt` set in the checkpoint,
 *      error-report absent. This locks in the post-fix-3 clean-walk
 *      behaviour as the positive counterpart of scenario 1.
 *
 *      The "mid-walk halt" snapshot that this slot used to hold (fix-1's
 *      h=1 sbox halt; fix-2's h=3850 shim halt; fix-2 T9's h=3850
 *      evaluate halt) has been retired — fix-3's smoke advances past
 *      h=10000 without halting. When 2j proper's deeper smokes surface
 *      a stable halt site somewhere ≥ h=10000, a future test can pin
 *      against it; until then, "clean tip-reach to a small height" is
 *      the cleanest signal.
 *
 * Both tests are subprocess-spawn integration tests against the built
 * `dist/main.js`. The real-data test skips when the 25 GB fixture is
 * absent so the suite remains useful in CI without the mainnet copy.
 *
 * # Why we don't assert on the specific `errorCode` for scenario (1)
 *
 * The startup halt's error string includes "store has no Headers (type
 * 101)" because the shim auto-creates the redb on open and immediately
 * trips its prerequisite check. If the shim's prereq messages are tuned
 * later this exact substring may change; we assert structurally (exit
 * code, presence of `ShimError`, no error-report) rather than on the
 * exact prose.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    runHarness,
    makeScratchDir,
    checkRealDataPrereqs,
    checkStartupOnlyPrereqs,
    SHIM_BINARY,
    DEFAULT_FIXTURE_STORE,
    type ScratchDir,
} from './_helpers.js';

describe('halt path (Layer 4)', () => {
    let scratch: ScratchDir | null = null;
    afterEach(() => {
        if (scratch !== null) {
            scratch.cleanup();
            scratch = null;
        }
    });

    it('startup halt: shim cannot serve GET_TIP_HEIGHT → exit 1, ShimError on stderr, no error-report sidecar', async () => {
        const skipReason = checkStartupOnlyPrereqs();
        if (skipReason !== null) {
            // Reported via console + a passing-but-empty assertion so the
            // skip is visible in the test output. We deliberately do NOT
            // use `it.skipIf` at registration time because the prereq
            // discovery is a per-run filesystem check, not a static condition.
            console.warn(`SKIP halt-path startup case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('halt-startup');
        const storePath = join(scratch.path, 'fresh-empty.redb');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        const run = await runHarness([
            '--store-path', storePath,
            '--shim-path', SHIM_BINARY,
            '--sidecar-path', sidecarPath,
            '--checkpoint-path', checkpointPath,
            '--error-report-path', errorReportPath,
            '--max-height', '1',
        ]);

        expect(run.exitCode).toBe(1);
        // Stderr surfaces the shim's prerequisite error. We assert structure
        // (ShimError mention + the `empty-store` code emitted by the shim's
        // T2 startup-check sites) without nailing the prose.
        expect(run.stderr).toContain('ShimError');
        expect(run.stderr).toContain('empty-store');
        // Per `main.ts` outer-catch policy: no error-report on startup halts.
        expect(existsSync(errorReportPath)).toBe(false);
        // Likewise no checkpoint — we never advanced past block 1.
        expect(existsSync(checkpointPath)).toBe(false);
    });

    it('clean tip-reach: short walk against bootstrap-data → exit 0, tipReachedAt set, no error-report', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP halt-path clean-walk case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('halt-clean-walk');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        // Post-fix-3, the harness walks heights 1..10000 cleanly against
        // the bootstrap-data snapshot (per 2026-05-22-fix-3-smoke.md).
        // We cap --max-height at 50 to keep the test under 1s while
        // still exercising the full clean-walk path: genesis seeding,
        // per-block validation, checkpoint advance, tipReachedAt write,
        // error-report-deletion-on-success.
        const run = await runHarness(
            [
                '--store-path', DEFAULT_FIXTURE_STORE,
                '--shim-path', SHIM_BINARY,
                '--sidecar-path', sidecarPath,
                '--checkpoint-path', checkpointPath,
                '--error-report-path', errorReportPath,
                '--max-height', '50',
            ],
            30_000,
        );

        expect(run.exitCode).toBe(0);
        expect(run.stdout).toMatch(/Walking 1\.\.50/);
        expect(run.stdout).toMatch(/Tip reached at height 50/);

        // Clean tip-reach: no error-report.
        expect(existsSync(errorReportPath)).toBe(false);

        // Checkpoint: lastValidatedHeight advanced; tipReachedAt set.
        expect(existsSync(checkpointPath)).toBe(true);
        const cp = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
            lastValidatedHeight: number;
            tipReachedAt?: string;
            stats: { totalBlocks: number; totalTxs: number; totalBoxesValidated: number };
        };
        expect(cp.lastValidatedHeight).toBe(50);
        expect(typeof cp.tipReachedAt).toBe('string');
        expect(cp.tipReachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // Stats sanity: 50 blocks should have at least 50 txs and at
        // least 100 boxes (each block has a coinbase tx producing
        // emission + reward outputs).
        expect(cp.stats.totalBlocks).toBe(50);
        expect(cp.stats.totalTxs).toBeGreaterThanOrEqual(50);
        expect(cp.stats.totalBoxesValidated).toBeGreaterThanOrEqual(100);
    }, 30_000);
});
