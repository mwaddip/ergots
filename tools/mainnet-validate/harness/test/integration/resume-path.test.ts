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
 *   3. The forward-only sidecar's collision behavior on a back-to-back
 *      re-run with an unadvanced checkpoint (the harness's documented
 *      semantics — the sidecar marker monotone-advances, so re-asking
 *      the rolling-window range on a second run emits `past-indexed`).
 *
 * The "walks 1 more block" sub-assertion in the spec is BLOCKED until
 * either:
 *   - the v0-tree library lands (`sbox-ergo-tree-no-size` fix), or
 *   - we ship a mocked-shim unit suite for the walk loop.
 *
 * Both are tracked in the 2j proper plan / T12 fix-list.
 *
 * # Why we don't compare the on-disk checkpoint contents post-run
 *
 * `writeCheckpoint` only fires after a SUCCESSFUL block validation
 * (`main.ts` line 455). Today's halt at block N means the checkpoint
 * file is never touched by the harness — its contents stay exactly what
 * we pre-wrote. Asserting that doesn't add signal beyond what the resume-
 * math stdout assertions already prove.
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
        shimPath: '/placeholder/shim',
        storePath: '/placeholder/store',
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

        // The walk halts on the v0-tree limitation at the first block it
        // tries to validate (block 101 per the resume math). Exit 1 +
        // halt diag on stderr.
        expect(run.exitCode).toBe(1);
        expect(run.stdout).toMatch(/Walking 101\.\.105/);
        expect(run.stderr).toMatch(/halt at height 101/);
        // Checkpoint never overwritten (no successful block).
        const cpAfter = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
        expect(cpAfter.lastValidatedHeight).toBe(100);
        // Error report MUST exist (validation halt branch wrote it).
        expect(existsSync(errorReportPath)).toBe(true);
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

        expect(run.exitCode).toBe(1);
        expect(run.stdout).toMatch(/Walking 50\.\.55/);
        expect(run.stderr).toMatch(/halt at height 50/);
    }, 60_000);

    it('back-to-back runs against the same sidecar collide via the forward-only walker (documents real semantics)', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP resume-path forward-walker case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('resume-fwd-walker');
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
            '--max-height', '205',
        ];

        const run1 = await runHarness(baseArgs);
        // First run: the harness reads the checkpoint (lastValidatedHeight=
        // 200), computes startHeight=201, then `rebuildWalkerState` fetches
        // headers from heights 191..200 to repopulate the rolling window.
        // Each header fetch via `GET_BLOCK` advances the shim's forward
        // walker, which builds the sidecar UTXO index for heights up to
        // and including the requested block. After run1, the sidecar's
        // `indexed_up_to_height` has advanced past 200.
        expect(run1.exitCode).toBe(1);
        expect(run1.stdout).toMatch(/Walking 201\.\.205/);
        expect(run1.stderr).toMatch(/halt at height 201/);

        // Second run with the SAME on-disk artifacts. The checkpoint still
        // says 200 (validation halts never overwrite the checkpoint), so
        // `rebuildWalkerState` again asks for headers from 191..200. But
        // the sidecar has now advanced past those heights, and the shim's
        // forward-only walker emits `past-indexed` for any GET_BLOCK at or
        // below its current marker (`shim/src/block_walker.rs`, T5 fix-list
        // documented this as expected behavior — the sidecar is monotone
        // and re-walks are not supported).
        const run2 = await runHarness(baseArgs);
        expect(run2.exitCode).toBe(1);
        expect(run2.stderr).toContain('past-indexed');
        // The second run halts BEFORE reaching the for-loop's "Walking
        // X..Y" stdout line because the failure surfaces from
        // `rebuildWalkerState` (called between checkpoint read and the
        // walk loop), which throws straight to `main`'s outer catch arm
        // and exits via the stderr path. No error-report (no specific
        // height context for the failure).
        expect(run2.stdout).not.toMatch(/Walking/);
    }, 90_000);
});
