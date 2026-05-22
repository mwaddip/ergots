/**
 * Integration test: harness halt path (Layer 4 of the mainnet-validate
 * spec).
 *
 * Two scenarios are exercised here as separate `it(...)` cases because
 * the harness writes different sidecars depending on WHEN the failure
 * fires:
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
 *   2. **Mid-walk halt** — a per-block failure that fires inside the
 *      walk loop (post-startup), exercising the catch arm at `main.ts`
 *      line 443-452 which writes `error-report.json` with phase,
 *      errorClass, errorCode, location, and a bundle excerpt, then
 *      returns exit code 1. After phase 2j-pre fix-1 (sbox-ergo-tree-no-size
 *      RESOLVED 2026-05-22), the previous-per-block library halt at h=1
 *      is gone; heights 1..3849 now validate cleanly. The next stable
 *      halt site is the shim walker bug at h=3850 (fix-list item 2,
 *      separate spec): phase 'shim', errorCode 'missing-utxo'. We
 *      assert against that halt site here. When fix-2 lands and the
 *      shim halt vanishes too, this test will need to either migrate
 *      to the next stable halt or switch to deliberate fault injection.
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
 *
 * # Why we DO assert on the specific `errorCode` for scenario (2)
 *
 * The shim halt at h=3850 is deterministic — the walker's UTXO index
 * fails to surface box `55274304…3c88aeda` reliably across runs. The
 * snapshot pins the specific phase / errorCode so a future regression
 * that REGRESSES behind today's halt (e.g., a re-introduction of the
 * sbox-ergo-tree-no-size halt at h=1) would surface as a meaningful
 * test diff. When fix-2 (shim walker) lands and unblocks h=3850, this
 * test's premise will need to migrate.
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

import type { ErrorReport } from '../../src/error-report.js';

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

    it('mid-walk halt: shim missing-utxo at h=3850 → exit 1, error-report.json written with phase + code', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP halt-path mid-walk case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('halt-validation');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        // Walk genesis through the known shim halt at h=3850. Per the
        // 2j-pre fix-1 Layer 3 smoke (T7), this walk validates heights
        // 1..3849 cleanly in ~27.5s then halts at h=3850 with the shim
        // walker's missing-utxo error. Vitest timeout bumped to 90_000
        // ms to accommodate the walk plus startup + sidecar build.
        const run = await runHarness([
            '--store-path', DEFAULT_FIXTURE_STORE,
            '--shim-path', SHIM_BINARY,
            '--sidecar-path', sidecarPath,
            '--checkpoint-path', checkpointPath,
            '--error-report-path', errorReportPath,
            '--max-height', '3850',
        ]);

        expect(run.exitCode).toBe(1);
        // stdout announces the walk range; stderr carries the halt diag.
        expect(run.stdout).toMatch(/Walking 1\.\.3850/);
        expect(run.stderr).toMatch(/halt at height 3850/);

        // error-report.json must be present and structurally well-formed.
        expect(existsSync(errorReportPath)).toBe(true);
        const reportRaw = readFileSync(errorReportPath, 'utf8');
        const report = JSON.parse(reportRaw) as ErrorReport;

        // Required top-level fields per `error-report.ts` `ErrorReport` shape.
        expect(report.height).toBe(3850);
        expect(typeof report.timestamp).toBe('string');
        expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(typeof report.phase).toBe('string');
        expect(typeof report.errorClass).toBe('string');
        expect(typeof report.message).toBe('string');
        expect(report.message.length).toBeGreaterThan(0);

        // The fix-2 halt point lives in the shim phase (the walker's UTXO
        // index missing-utxo bug at h=3850). If this changes — either
        // because fix-2 lands or a regression surfaces a different halt
        // earlier in the walk — the snapshot below will fail loudly.
        expect(report.phase).toBe('shim');
        expect(report.errorClass).toBe('ShimError');
        expect(report.errorCode).toBe('missing-utxo');
        // The shim halt fires BEFORE the harness gets a bundle, so the
        // bundleExcerpt and location are absent (location is `{}` per
        // error-report.ts when no per-block context is available).
        expect(Object.keys(report.location).length).toBe(0);

        // Checkpoint reflects the LAST successfully-validated block.
        expect(existsSync(checkpointPath)).toBe(true);
        const cp = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { lastValidatedHeight: number };
        expect(cp.lastValidatedHeight).toBe(3849);
    }, 90_000);
});
