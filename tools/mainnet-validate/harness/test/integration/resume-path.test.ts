/**
 * Integration test: harness resume path (Layer 5 of the mainnet-validate
 * spec).
 *
 * The resume path is "harness reads an existing `checkpoint.json` and
 * picks up the walk at `lastValidatedHeight + 1`". The spec's original
 * Layer 5 sketch was "run once to height H succeed; run again, walk one
 * more block", but per the T12 fix-list every block currently halts on
 * the v0-tree library limitation so no run can advance the on-disk
 * checkpoint by itself.
 *
 * What we CAN test deterministically today:
 *   1. The harness's checkpoint-read + resume-math wiring: pre-write a
 *      well-formed checkpoint with `lastValidatedHeight = N`, run the
 *      harness without `--start-height`, observe stdout reporting
 *      `Walking N+1..<requested-end>`. This proves the harness picked
 *      the checkpoint up and used it.
 *   2. The `--start-height` override: pass `--start-height N+10` and
 *      observe the override taking precedence over the checkpoint.
 *   3. The clean-resume back-to-back path: run once advancing the
 *      sidecar's `indexed_up_to_height`, then run again with a higher
 *      `--max-height`. As of phase 2j-b-resume (PROTOCOL_VERSION 3),
 *      `rebuildWalkerState` uses the new `GET_HEADER` verb so the rolling
 *      window can be repopulated from any past height regardless of
 *      sidecar state; both runs exit 0 and the checkpoint
 *      monotonically advances.
 *
 * After phase 2j-pre fix-1 (sbox-ergo-tree-no-size RESOLVED 2026-05-22),
 * the library halt at h=1 is gone. A "walks 1 more block" sub-assertion
 * could now be wired against the bootstrap-data fixture for heights
 * below 3850 (where the shim walker bug halts). The current test file
 * tests resume-math + forward-only sidecar collision behavior, both
 * deterministic; adding a "walks 1 more block" assertion is a clean
 * extension for a future T8b once T8's halt-path test confirms stable
 * post-fix-1 behavior.
 *
 * # Why we don't compare the on-disk checkpoint contents post-run
 *
 * `writeCheckpoint` only fires after a SUCCESSFUL block validation
 * (`main.ts` line 455). The current tests use scenarios that halt
 * BEFORE writing the checkpoint (forward-only sidecar collision; bad
 * shim-path), so the checkpoint stays exactly what we pre-wrote.
 * Asserting that doesn't add signal beyond what the resume-math stdout
 * assertions already prove. Post-fix-1, scenarios that walk past
 * h>0 successfully WILL touch the checkpoint — a future test
 * extension could assert on the updated state.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    runHarness,
    makeScratchDir,
    checkRealDataPrereqs,
    SHIM_BINARY,
    DEFAULT_FIXTURE_STORE,
    type ScratchDir,
} from './_helpers.js';

import type { Checkpoint } from '../../src/checkpoint.js';

/**
 * Build a synthetic checkpoint at the requested `lastValidatedHeight`.
 * Library versions are placeholder strings; the harness's mismatch check
 * just warns on a difference vs `currentLibraryVersions()` (Open item #2
 * of the spec: warn-and-continue), so a mismatch is benign for the
 * resume-math assertions here.
 */
function buildCheckpoint(lastValidatedHeight: number): Checkpoint {
    return {
        lastValidatedHeight,
        tipHeightAtStart: 1_790_510,
        lastValidatedAt: '2026-05-21T00:00:00.000Z',
        nodeUrl: 'shim://local',
        indexerUrl: 'shim://local',
        libraryVersions: {
            scorex: '0.0.0-t13-fixture',
            nipopow: '0.0.0-t13-fixture',
            avltree: '0.0.0-t13-fixture',
            ergoscript: '0.0.0-t13-fixture',
        },
        stats: {
            totalBlocks: 0,
            totalTxs: 0,
            totalBoxesValidated: 0,
            totalSpendsValidated: 0,
            startedAt: '2026-05-21T00:00:00.000Z',
            elapsedMs: 0,
        },
    };
}

describe('resume path (Layer 5)', () => {
    let scratch: ScratchDir | null = null;
    afterEach(() => {
        if (scratch !== null) {
            scratch.cleanup();
            scratch = null;
        }
    });

    it('reads checkpoint.lastValidatedHeight and resumes the walk at +1', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP resume-path resume case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('resume-checkpoint');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        const cp = buildCheckpoint(100);
        writeFileSync(checkpointPath, `${JSON.stringify(cp, null, 2)}\n`, 'utf8');

        const run = await runHarness([
            '--store-path', DEFAULT_FIXTURE_STORE,
            '--shim-path', SHIM_BINARY,
            '--sidecar-path', sidecarPath,
            '--checkpoint-path', checkpointPath,
            '--error-report-path', errorReportPath,
            // End cap above the checkpoint so the resume math has room.
            '--max-height', '105',
        ]);

        // After phase 2j-pre fix-1, heights 101..105 validate cleanly
        // (the previous sbox-ergo-tree-no-size halt at the first walked
        // block is RESOLVED). The walk reaches the tip cap and exits 0
        // with checkpoint advanced.
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toMatch(/Walking 101\.\.105/);
        expect(run.stdout).toMatch(/Tip reached at height 105/);
        // Checkpoint advanced through the walk to lastValidatedHeight=105.
        const cpAfter = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
        expect(cpAfter.lastValidatedHeight).toBe(105);
        expect(typeof cpAfter.tipReachedAt).toBe('string');
        // No error report (tip-reached path deletes any stale sidecar).
        expect(existsSync(errorReportPath)).toBe(false);
    }, 60_000);

    it('--start-height overrides checkpoint.lastValidatedHeight', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP resume-path override case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('resume-override');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        // Checkpoint says "resume at 101", but --start-height 50 must win.
        const cp = buildCheckpoint(100);
        writeFileSync(checkpointPath, `${JSON.stringify(cp, null, 2)}\n`, 'utf8');

        const run = await runHarness([
            '--store-path', DEFAULT_FIXTURE_STORE,
            '--shim-path', SHIM_BINARY,
            '--sidecar-path', sidecarPath,
            '--checkpoint-path', checkpointPath,
            '--error-report-path', errorReportPath,
            '--start-height', '50',
            '--max-height', '55',
        ]);

        // After fix-1, heights 50..55 validate cleanly. The CLI override
        // is verified via the stdout's "Walking 50..55" announcement —
        // the override took precedence over the checkpoint's 101.
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toMatch(/Walking 50\.\.55/);
        expect(run.stdout).toMatch(/Tip reached at height 55/);
    }, 60_000);

    it('back-to-back runs against the same sidecar resume cleanly via the GET_HEADER verb', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP resume-path back-to-back case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('resume-back-to-back');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        const cp = buildCheckpoint(200);
        writeFileSync(checkpointPath, `${JSON.stringify(cp, null, 2)}\n`, 'utf8');

        const baseArgs = [
            '--store-path', DEFAULT_FIXTURE_STORE,
            '--shim-path', SHIM_BINARY,
            '--sidecar-path', sidecarPath,
            '--checkpoint-path', checkpointPath,
            '--error-report-path', errorReportPath,
        ];

        const run1 = await runHarness([...baseArgs, '--max-height', '205']);
        // First run: the harness reads the checkpoint (lastValidatedHeight=
        // 200), computes startHeight=201, then `rebuildWalkerState` fetches
        // headers from heights 191..200 via the new `GET_HEADER` verb. The
        // walk through 201..205 completes cleanly; the sidecar's
        // `indexed_up_to_height` advances to 205.
        expect(run1.exitCode).toBe(0);
        expect(run1.stdout).toMatch(/Walking 201\.\.205/);
        expect(run1.stdout).toMatch(/Tip reached at height 205/);

        // Second run with the SAME on-disk artifacts but a higher
        // --max-height. The checkpoint now says 205 (advanced through
        // run1); startHeight becomes 206. `rebuildWalkerState` asks for
        // headers from 196..205 to repopulate the rolling window. Pre-2j-b-
        // resume, this would have failed with `past-indexed` because
        // GET_BLOCK enforces the forward-walker constraint. Now
        // `rebuildWalkerState` uses GET_HEADER, which bypasses that
        // constraint — header bytes come straight from the store via
        // `read_header_at`. The second run walks 206..210 cleanly, advancing
        // the sidecar to 210 and the checkpoint to lastValidatedHeight=210.
        const run2 = await runHarness([...baseArgs, '--max-height', '210']);
        expect(run2.exitCode).toBe(0);
        expect(run2.stdout).toMatch(/Walking 206\.\.210/);
        expect(run2.stdout).toMatch(/Tip reached at height 210/);
        expect(run2.stderr).not.toContain('past-indexed');
        const cpAfter = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
        expect(cpAfter.lastValidatedHeight).toBe(210);
    }, 120_000);
});
