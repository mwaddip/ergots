/**
 * Unit tests for `error-report.ts`. Covers:
 *   1. Write happy path; file on disk matches the in-memory shape.
 *   2. All 5 `phase` values write cleanly.
 *   3. Minimal report (empty location + bundleExcerpt) writes cleanly.
 *   4. `deleteErrorReport` removes the file and is idempotent.
 *   5. Optional fields (errorCode, stack) survive when present.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    writeErrorReport,
    deleteErrorReport,
    type ErrorReport,
    type ErrorPhase,
} from '../src/error-report.js';

function makeFullReport(): ErrorReport {
    return {
        timestamp: '2026-05-22T12:34:56.789Z',
        height: 1_234_567,
        phase: 'evaluate',
        errorClass: 'EvalError',
        errorCode: 'unknown-method',
        message: 'method 42 not implemented on SCollection',
        stack: 'EvalError: method ...\n  at evaluate (...)',
        location: {
            txIndex: 3,
            txId: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            inputIndex: 1,
            outputIndex: 0,
            spentBoxId: 'abcd'.repeat(16),
            ergoTreeHex: '0008cd02' + '00'.repeat(33),
        },
        bundleExcerpt: {
            headerHex: 'ff'.repeat(80),
            txHex: 'ab'.repeat(100),
            spentBoxHex: 'cd'.repeat(50),
        },
    };
}

describe('error-report', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ergots-error-report-test-'));
        path = join(dir, 'error-report.json');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('writes a full report and the JSON on disk matches the input', () => {
        const r = makeFullReport();
        writeErrorReport(path, r);
        const raw = readFileSync(path, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        expect(parsed).toEqual(r);
    });

    it('writes a trailing newline and pretty-printed JSON', () => {
        writeErrorReport(path, makeFullReport());
        const raw = readFileSync(path, 'utf8');
        expect(raw.endsWith('\n')).toBe(true);
        expect(raw.split('\n').length).toBeGreaterThan(5);
    });

    it('writes cleanly for all 5 phase values', () => {
        const phases: ErrorPhase[] = [
            'header',
            'output-roundtrip',
            'evaluate',
            'verify-signature',
            'shim',
        ];
        for (const phase of phases) {
            const r: ErrorReport = {
                timestamp: '2026-05-22T12:00:00.000Z',
                height: 1,
                phase,
                errorClass: 'Error',
                message: `synthetic ${phase}`,
                location: {},
                bundleExcerpt: {},
            };
            writeErrorReport(path, r);
            const parsed = JSON.parse(readFileSync(path, 'utf8')) as ErrorReport;
            expect(parsed.phase).toBe(phase);
        }
    });

    it('writes a minimal report (no optional fields) cleanly', () => {
        const minimal: ErrorReport = {
            timestamp: '2026-05-22T12:00:00.000Z',
            height: 1,
            phase: 'header',
            errorClass: 'HeaderParseError',
            message: 'invalid version byte',
            location: {},
            bundleExcerpt: {},
        };
        writeErrorReport(path, minimal);
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as ErrorReport;
        expect(parsed).toEqual(minimal);
        // Optional fields must not be serialized when undefined.
        expect(Object.prototype.hasOwnProperty.call(parsed, 'errorCode')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(parsed, 'stack')).toBe(false);
    });

    it('overwrites an existing report on a second write', () => {
        const first = makeFullReport();
        writeErrorReport(path, first);
        const second: ErrorReport = { ...first, message: 'second halt' };
        writeErrorReport(path, second);
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as ErrorReport;
        expect(parsed.message).toBe('second halt');
    });

    it('deleteErrorReport removes the file when it exists', () => {
        writeErrorReport(path, makeFullReport());
        expect(existsSync(path)).toBe(true);
        deleteErrorReport(path);
        expect(existsSync(path)).toBe(false);
    });

    it('deleteErrorReport is idempotent when the file is missing', () => {
        expect(existsSync(path)).toBe(false);
        expect(() => deleteErrorReport(path)).not.toThrow();
    });
});
