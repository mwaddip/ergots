/**
 * Unit tests for `main.ts` helpers (`classifyError`, `updateCheckpointStats`).
 *
 * `main()` itself spawns the shim subprocess and exercises the full walk
 * loop — that's covered by the T12 end-to-end smoke test against real
 * data, not here. These unit tests cover the two pure-function helpers
 * that determine sidecar shape on halt.
 */

import { describe, expect, it } from 'vitest';

import {
    classifyError,
    updateCheckpointStats,
} from '../src/main.js';
import { HarnessError } from '../src/errors.js';
import { ShimError } from '../src/protocol.js';
import type { BlockBundle } from '../src/protocol.js';
import type { Checkpoint } from '../src/checkpoint.js';

function makeBundle(): BlockBundle {
    return {
        height: 100,
        blockId: new Uint8Array(32),
        parentId: new Uint8Array(32),
        headerBytes: Uint8Array.from([0xab, 0xcd, 0xef]),
        headerJson: '',
        transactions: [
            {
                txId: new Uint8Array(32),
                signingMessage: new Uint8Array(0),
                inputs: [
                    {
                        boxId: new Uint8Array(32),
                        spentBoxBytes: new Uint8Array(0),
                        signatureBytes: new Uint8Array(0),
                        contextExtension: [],
                        oracleCost: 0n,
                        oracleSucceeded: true,
                        oracleError: null,
                    },
                    {
                        boxId: new Uint8Array(32),
                        spentBoxBytes: new Uint8Array(0),
                        signatureBytes: new Uint8Array(0),
                        contextExtension: [],
                        oracleCost: 0n,
                        oracleSucceeded: true,
                        oracleError: null,
                    },
                ],
                outputs: [new Uint8Array(1), new Uint8Array(1), new Uint8Array(1)],
                dataInputBoxes: [],
            },
        ],
        parameters: null,
    };
}

function makeCheckpoint(): Checkpoint {
    return {
        lastValidatedHeight: 99,
        tipHeightAtStart: 1_000_000,
        lastValidatedAt: '2026-05-22T11:00:00.000Z',
        nodeUrl: 'shim://local',
        indexerUrl: 'shim://local',
        libraryVersions: {
            scorex: '0.1.0',
            nipopow: '0.2.0',
            avltree: '0.2.0',
            ergoscript: '0.2.0',
        },
        stats: {
            totalBlocks: 5,
            totalTxs: 10,
            totalBoxesValidated: 20,
            totalSpendsValidated: 15,
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            elapsedMs: 60_000,
        },
    };
}

describe('classifyError', () => {
    it('reports a HarnessError with its phase, code, and location', () => {
        const err = new HarnessError(
            'evaluate',
            'verifier-false',
            'verifier returned false',
            { txIndex: 0, inputIndex: 1 },
        );
        const bundle = makeBundle();
        const report = classifyError(err, 100, bundle);
        expect(report.height).toBe(100);
        expect(report.phase).toBe('evaluate');
        expect(report.errorClass).toBe('HarnessError');
        expect(report.errorCode).toBe('verifier-false');
        expect(report.message).toBe('verifier returned false');
        expect(report.location).toEqual({ txIndex: 0, inputIndex: 1 });
        expect(report.bundleExcerpt.headerHex).toBe('abcdef');
    });

    it('reports a ShimError with phase=shim and the shim error code', () => {
        const err = new ShimError('missing-block', 'no such block at 100');
        const bundle = makeBundle();
        const report = classifyError(err, 100, bundle);
        expect(report.phase).toBe('shim');
        expect(report.errorClass).toBe('ShimError');
        expect(report.errorCode).toBe('missing-block');
        expect(report.message).toContain('missing-block');
        expect(report.location).toEqual({});
        expect(report.bundleExcerpt.headerHex).toBe('abcdef');
    });

    it('falls back to phase=shim for a generic Error', () => {
        const err = new TypeError('weird unexpected thing');
        const report = classifyError(err, 100, undefined);
        expect(report.phase).toBe('shim');
        expect(report.errorClass).toBe('TypeError');
        expect(report.errorCode).toBeUndefined();
        expect(report.message).toBe('weird unexpected thing');
        expect(report.bundleExcerpt).toEqual({});
    });

    it('handles a non-Error throw (string) without crashing', () => {
        const report = classifyError('something string-y', 100, undefined);
        expect(report.phase).toBe('shim');
        expect(report.errorClass).toBe('Error');
        expect(report.message).toBe('something string-y');
    });

    it('flattens HarnessError 2j-a payload fields into ErrorReport top-level keys', () => {
        // cost-drift (evaluate-cost phase)
        const driftErr = new HarnessError(
            'evaluate-cost',
            'cost-drift',
            'cost-drift: oracle 999 vs ours 50 (delta 949)',
            { txIndex: 0, inputIndex: 0 },
            { evaluateCost: { expected: 999, actual: 50, delta: 949 } },
        );
        const driftReport = classifyError(driftErr, 1, undefined);
        expect(driftReport.phase).toBe('evaluate-cost');
        expect(driftReport.errorCode).toBe('cost-drift');
        expect(driftReport.evaluateCost).toEqual({ expected: 999, actual: 50, delta: 949 });
        expect(driftReport.oracleError).toBeUndefined();
        expect(driftReport.ourError).toBeUndefined();
        expect(driftReport.ourEvaluateCost).toBeUndefined();

        // ours-succeeded-oracle-errored (evaluate-oracle-mismatch phase)
        const mismatchErr = new HarnessError(
            'evaluate-oracle-mismatch',
            'ours-succeeded-oracle-errored',
            'oracle errored but our eval succeeded',
            { txIndex: 0, inputIndex: 0 },
            {
                ourError: null,
                oracleError: 'simulated oracle eval error',
                ourEvaluateCost: 50,
            },
        );
        const mismatchReport = classifyError(mismatchErr, 1, undefined);
        expect(mismatchReport.phase).toBe('evaluate-oracle-mismatch');
        expect(mismatchReport.errorCode).toBe('ours-succeeded-oracle-errored');
        expect(mismatchReport.oracleError).toBe('simulated oracle eval error');
        expect(mismatchReport.ourError).toBeNull();
        expect(mismatchReport.ourEvaluateCost).toBe(50);
        expect(mismatchReport.evaluateCost).toBeUndefined();

        // Non-2j-a HarnessError leaves all 4 fields undefined.
        const plainErr = new HarnessError(
            'evaluate',
            'verifier-false',
            'verifier returned false',
            { txIndex: 0, inputIndex: 1 },
        );
        const plainReport = classifyError(plainErr, 1, undefined);
        expect(plainReport.evaluateCost).toBeUndefined();
        expect(plainReport.oracleError).toBeUndefined();
        expect(plainReport.ourError).toBeUndefined();
        expect(plainReport.ourEvaluateCost).toBeUndefined();
    });
});

describe('updateCheckpointStats', () => {
    it('increments every counter and updates lastValidatedHeight', () => {
        const c = makeCheckpoint();
        const bundle = makeBundle();
        updateCheckpointStats(c, bundle);
        // 1 block added; 1 tx added; 3 outputs; 2 inputs.
        expect(c.stats.totalBlocks).toBe(6);
        expect(c.stats.totalTxs).toBe(11);
        expect(c.stats.totalBoxesValidated).toBe(23);
        expect(c.stats.totalSpendsValidated).toBe(17);
        expect(c.lastValidatedHeight).toBe(100);
        expect(c.lastValidatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // Elapsed should be roughly 60s (within a generous window for slow CI).
        expect(c.stats.elapsedMs).toBeGreaterThanOrEqual(60_000);
        expect(c.stats.elapsedMs).toBeLessThan(120_000);
    });

    it('sums multi-tx box and spend counts correctly', () => {
        const c = makeCheckpoint();
        const bundle = makeBundle();
        // Append a second tx with 5 outputs and 0 inputs.
        bundle.transactions.push({
            txId: new Uint8Array(32),
            signingMessage: new Uint8Array(0),
            inputs: [],
            outputs: [
                new Uint8Array(1),
                new Uint8Array(1),
                new Uint8Array(1),
                new Uint8Array(1),
                new Uint8Array(1),
            ],
            dataInputBoxes: [],
        });
        updateCheckpointStats(c, bundle);
        // 1 block; 2 txs; 3+5=8 outputs; 2+0=2 inputs.
        expect(c.stats.totalBlocks).toBe(6);
        expect(c.stats.totalTxs).toBe(12);
        expect(c.stats.totalBoxesValidated).toBe(28);
        expect(c.stats.totalSpendsValidated).toBe(17);
    });
});
