/**
 * Integration test: harness tip-reach path (Layer 6 of the
 * mainnet-validate spec).
 *
 * The spec's Layer 6 ideal is "harness walks every block from start to
 * `--max-height M`, then sets `checkpoint.tipReachedAt` and deletes any
 * stale `error-report.json`" (`main.ts` lines 460-466). That code path
 * fires ONLY after the for-loop completes — which requires at least one
 * successful `validateBlock` call. Per the T12 fix-list, the v0-tree
 * library cannot validate any block yet (`sbox-ergo-tree-no-size` halts
 * at output 0 of every block's first tx). Until that fix lands, the
 * full-walk tip-reach branch is unreachable in an integration test.
 *
 * What we CAN test deterministically today:
 *   - The "Nothing to do" branch at `main.ts` lines 386-393, which is the
 *     observable equivalent of "we're already at/past the requested end".
 *     This branch is hit when the resolved `startHeight > endHeight`
 *     (e.g., a checkpoint past `--max-height`, or `--max-height` below 1
 *     with no checkpoint). It returns exit 0, prints "Nothing to do" to
 *     stdout, and intentionally does NOT mutate the checkpoint or delete
 *     the error-report (those are exclusive to the full tip-reach branch).
 *
 *   - `--max-height` is clamped to the shim's reported tip
 *     (`main.ts` line 384: `Math.min(requestedEnd, tipHeight)`). This is
 *     the spec's "or cap the harness's walk at `--max-height N` for
 *     testing" workaround — but combined with our every-block-halts
 *     reality, the only way to exercise the clamp without triggering a
 *     validation halt is to push `--max-height` below the start height
 *     (the "Nothing to do" case above).
 *
 * # Future test (once v0-tree fix lands)
 *
 * Add an `it(...)` here that walks a small height range against the same
 * fixture, asserts exit 0, reads the checkpoint and confirms both
 * `tipReachedAt` is set AND `lastValidatedHeight === endHeight`, then
 * confirms the error-report was deleted. The test scaffolding (helpers,
 * scratch dir, fixture-path detection) is already in place for that
 * extension.
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
import type { ErrorReport } from '../../src/error-report.js';

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

describe('tip-reach path (Layer 6)', () => {
    let scratch: ScratchDir | null = null;
    afterEach(() => {
        if (scratch !== null) {
            scratch.cleanup();
            scratch = null;
        }
    });

    it('checkpoint past --max-height → exit 0, "Nothing to do" branch, no checkpoint mutation', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP tip-reach-path checkpoint-past case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('tip-reach-cp-past');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        // Checkpoint says we're already at 1000; cap walk at 500.
        const cpBefore = buildCheckpoint(1000);
        writeFileSync(checkpointPath, `${JSON.stringify(cpBefore, null, 2)}\n`, 'utf8');

        const run = await runHarness([
            '--store-path', DEFAULT_FIXTURE_STORE,
            '--shim-path', SHIM_BINARY,
            '--sidecar-path', sidecarPath,
            '--checkpoint-path', checkpointPath,
            '--error-report-path', errorReportPath,
            '--max-height', '500',
        ]);

        expect(run.exitCode).toBe(0);
        expect(run.stdout).toMatch(
            /Nothing to do: startHeight=1001 > endHeight=500/,
        );
        // The "Nothing to do" branch is read-only: no writeCheckpoint call
        // and no deleteErrorReport call. Verify the on-disk checkpoint is
        // byte-for-byte the same as what we pre-wrote (modulo trailing
        // whitespace from the test's JSON.stringify formatting).
        const cpAfter = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
        expect(cpAfter).toEqual(cpBefore);
        // tipReachedAt was NOT set (that's exclusive to the full-walk
        // branch which is currently unreachable; this documents the limit).
        expect(cpAfter.tipReachedAt).toBeUndefined();
        // No error-report written; the branch doesn't touch the sidecar.
        expect(existsSync(errorReportPath)).toBe(false);
    }, 30_000);

    it('checkpoint past --max-height does NOT clear a pre-existing error-report (only full-walk tip-reach does)', async () => {
        const skipReason = checkRealDataPrereqs();
        if (skipReason !== null) {
            console.warn(`SKIP tip-reach-path stale-report case: ${skipReason}`);
            return;
        }

        scratch = makeScratchDir('tip-reach-stale-report');
        const sidecarPath = join(scratch.path, 'sidecar.redb');
        const checkpointPath = join(scratch.path, 'checkpoint.json');
        const errorReportPath = join(scratch.path, 'error-report.json');

        const cp = buildCheckpoint(1000);
        writeFileSync(checkpointPath, `${JSON.stringify(cp, null, 2)}\n`, 'utf8');

        // Plant a stale error-report from a prior hypothetical halt.
        const staleReport: ErrorReport = {
            timestamp: '2026-05-21T00:00:00.000Z',
            height: 999,
            phase: 'output-roundtrip',
            errorClass: 'HarnessError',
            errorCode: 'sbox-parse-failed',
            message: 'stale fixture from a prior run',
            location: { txIndex: 0, outputIndex: 0 },
            bundleExcerpt: { headerHex: 'deadbeef' },
        };
        writeFileSync(
            errorReportPath,
            `${JSON.stringify(staleReport, null, 2)}\n`,
            'utf8',
        );

        const run = await runHarness([
            '--store-path', DEFAULT_FIXTURE_STORE,
            '--shim-path', SHIM_BINARY,
            '--sidecar-path', sidecarPath,
            '--checkpoint-path', checkpointPath,
            '--error-report-path', errorReportPath,
            '--max-height', '500',
        ]);

        expect(run.exitCode).toBe(0);
        expect(run.stdout).toMatch(
            /Nothing to do: startHeight=1001 > endHeight=500/,
        );
        // The stale report is NOT cleared: deleteErrorReport is only called
        // from the full-walk tip-reach branch (`main.ts` line 464), not
        // from "Nothing to do". This documents the current behavior so a
        // future change moving deleteErrorReport into the "Nothing to do"
        // branch would surface here.
        expect(existsSync(errorReportPath)).toBe(true);
        const stillThere = JSON.parse(readFileSync(errorReportPath, 'utf8')) as ErrorReport;
        expect(stillThere.height).toBe(999);
        expect(stillThere.errorCode).toBe('sbox-parse-failed');
    }, 30_000);
});
