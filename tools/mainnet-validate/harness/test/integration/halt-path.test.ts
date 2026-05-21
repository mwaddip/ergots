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
 *   2. **Validation halt** — a real per-block validation failure mid-walk.
 *      Against the 25 GB mainnet copy, every block currently halts at
 *      output index 0 of the first transaction because the v0-tree
 *      library does not support `hasSize=false` (the
 *      `sbox-ergo-tree-no-size` fix-list item from T12). This is the
 *      exact halt path the harness was designed for: the catch arm at
 *      `main.ts` line 443-452 writes `error-report.json` with phase,
 *      errorClass, errorCode, location, and a bundle excerpt, then
 *      returns exit code 1.
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
 * # Why we don't assert on the specific `errorCode` for scenario (2)
 *
 * Once the v0-tree fix-list item lands, the validation halt will move
 * past output-roundtrip into evaluate or verify-signature (or vanish
 * entirely once enough scope ships). We assert structurally that an
 * error-report was written with the expected top-level shape, then
 * snapshot the specific phase / code so a future regression that
 * REGRESSES behind today's halt point would surface as a meaningful
 * test diff.
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

    it('validation halt: per-block failure mid-walk → exit 1, error-report.json written with phase + code + location + bundleExcerpt', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP halt-path validation case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('halt-validation');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        const run = await runHarness([
            '--store-path', DEFAULT_FIXTURE_STORE,
            '--shim-path', SHIM_BINARY,
            '--sidecar-path', sidecarPath,
            '--checkpoint-path', checkpointPath,
            '--error-report-path', errorReportPath,
            '--max-height', '1',
        ]);

        expect(run.exitCode).toBe(1);
        // stdout announces the walk range; stderr carries the halt diag.
        expect(run.stdout).toMatch(/Walking 1\.\.1/);
        expect(run.stderr).toMatch(/halt at height 1 \(validation failed\)/);

        // error-report.json must be present and structurally well-formed.
        expect(existsSync(errorReportPath)).toBe(true);
        const reportRaw = readFileSync(errorReportPath, 'utf8');
        const report = JSON.parse(reportRaw) as ErrorReport;

        // Required top-level fields per `error-report.ts` `ErrorReport` shape.
        expect(report.height).toBe(1);
        expect(typeof report.timestamp).toBe('string');
        expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(typeof report.phase).toBe('string');
        expect(typeof report.errorClass).toBe('string');
        expect(typeof report.message).toBe('string');
        expect(report.message.length).toBeGreaterThan(0);

        // Today's halt point (the `sbox-ergo-tree-no-size` v0-tree library
        // gap) lives in the output-roundtrip phase. If this changes —
        // either because we move past it or REGRESS behind it — the snapshot
        // below will fail loudly, which is the desired signal.
        expect(report.phase).toBe('output-roundtrip');
        expect(report.errorClass).toBe('HarnessError');
        expect(report.errorCode).toBe('sbox-parse-failed');
        // Location precision matches the validator's per-output throw site.
        expect(report.location.txIndex).toBe(0);
        expect(report.location.outputIndex).toBe(0);

        // Bundle excerpt: header bytes (hex) are always populated when the
        // shim returned a bundle (validation halts run AFTER the fetch).
        expect(typeof report.bundleExcerpt.headerHex).toBe('string');
        expect(report.bundleExcerpt.headerHex!.length).toBeGreaterThan(0);
        // Header hex must be even-length (whole bytes only).
        expect(report.bundleExcerpt.headerHex!.length % 2).toBe(0);
    }, 30_000);
});
