/**
 * Unit tests for `degrade-census.ts`: the census of output trees that degrade to an
 * `UnparsedErgoTree` under the box rules (spec 2026-09-28 §12). Later runs fail on any
 * difference from the established set, in either direction.
 *
 * The trees are fresh arrays, so `boxTreeOf` parses each one standalone (a cache miss).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DegradeCensus } from '../src/degrade-census.js';
import { HarnessError } from '../src/errors.js';

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** The HarnessError `fn` throws, or a failure if it throws nothing or something else. */
function harnessErrorOf(fn: () => void): HarnessError {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(HarnessError);
        return e as HarnessError;
    }
    throw new Error('expected a HarnessError, got no throw');
}

/** sigmaProp(true) in a size-flagged v1 tree: parses under the box rules. */
const PARSED_TREE = '090208d3';
/** The mainnet burn box's tree (h=545,684): a Byte-constant root, so rule 1001 degrades it. */
const BURN_TREE = 'cd07021a8e6f59fd4a';

describe('DegradeCensus', () => {
    let dir: string;
    let expectedPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ergots-census-'));
        expectedPath = join(dir, 'census-expected.json');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function observed(): unknown[] {
        const path = `${expectedPath}.observed.jsonl`;
        if (!existsSync(path)) return [];
        return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    }

    function writeExpected(entries: unknown): void {
        writeFileSync(expectedPath, JSON.stringify(entries));
    }

    it('records nothing for a tree that parses', () => {
        const census = new DegradeCensus(expectedPath);
        expect(() => census.record(100, 0, 0, hexToBytes(PARSED_TREE))).not.toThrow();
        expect(observed()).toEqual([]);
    });

    it('halts on a degrade the expected file does not list, after logging it', () => {
        // No expected file yet: the first run establishes the set.
        const census = new DegradeCensus(expectedPath);
        const he = harnessErrorOf(() => census.record(545684, 1, 0, hexToBytes(BURN_TREE)));
        expect(he.phase).toBe('census');
        expect(he.code).toBe('census-unexpected-degrade');
        expect(he.location).toEqual({ txIndex: 1, outputIndex: 0, ergoTreeHex: BURN_TREE });
        expect(observed()).toEqual([
            { height: 545684, txIndex: 1, outputIndex: 0, error: expect.stringMatching(/rule 1001/), ergoTreeHex: BURN_TREE },
        ]);
    });

    it('passes a degrade the expected file lists, and logs it', () => {
        writeExpected([{ height: 545684, txIndex: 1, outputIndex: 0, reason: 'burn box: rule 1001' }]);
        const census = new DegradeCensus(expectedPath);
        expect(() => census.record(545684, 1, 0, hexToBytes(BURN_TREE))).not.toThrow();
        expect(observed()).toHaveLength(1);
    });

    it('keys an entry on height, tx and output: the same tree elsewhere halts', () => {
        writeExpected([{ height: 545684, txIndex: 1, outputIndex: 0, reason: 'burn box: rule 1001' }]);
        const census = new DegradeCensus(expectedPath);
        for (const [height, txIndex, outputIndex] of [[545684, 1, 1], [545684, 0, 0], [545685, 1, 0]] as const) {
            const he = harnessErrorOf(() => census.record(height, txIndex, outputIndex, hexToBytes(BURN_TREE)));
            expect(he.code).toBe('census-unexpected-degrade');
        }
    });

    it('halts when a listed degrade does not happen (any difference fails)', () => {
        writeExpected([{ height: 545684, txIndex: 1, outputIndex: 0, reason: 'burn box: rule 1001' }]);
        const census = new DegradeCensus(expectedPath);
        const he = harnessErrorOf(() => census.record(545684, 1, 0, hexToBytes(PARSED_TREE)));
        expect(he.phase).toBe('census');
        expect(he.code).toBe('census-expected-degrade-missing');
        expect(he.location).toEqual({ txIndex: 1, outputIndex: 0, ergoTreeHex: PARSED_TREE });
        expect(observed()).toEqual([]);
    });

    it('rejects an expected file that is not an array of justified entries', () => {
        const cases: Array<[string, RegExp]> = [
            ['[{"height": 545684,', /JSON/],
            [JSON.stringify({ height: 545684 }), /JSON array/],
            [JSON.stringify([{ height: 545684, txIndex: 1, outputIndex: 0 }]), /reason/],
            [JSON.stringify([{ height: '545684', txIndex: 1, outputIndex: 0, reason: 'burn box' }]), /height/],
        ];
        for (const [text, message] of cases) {
            writeFileSync(expectedPath, text);
            const he = harnessErrorOf(() => new DegradeCensus(expectedPath));
            expect(he.phase).toBe('census');
            expect(he.code).toBe('census-file-malformed');
            expect(he.message).toMatch(message);
        }
    });

    it('counts the expected entries (reported when a walk starts)', () => {
        expect(new DegradeCensus(expectedPath).expectedCount).toBe(0);
        writeExpected([{ height: 545684, txIndex: 1, outputIndex: 0, reason: 'burn box: rule 1001' }]);
        expect(new DegradeCensus(expectedPath).expectedCount).toBe(1);
    });

    it('logs each degrade once: halt, add the entry, resume', () => {
        const first = new DegradeCensus(expectedPath);
        expect(harnessErrorOf(() => first.record(545684, 1, 0, hexToBytes(BURN_TREE))).code)
            .toBe('census-unexpected-degrade');
        writeExpected([{ height: 545684, txIndex: 1, outputIndex: 0, reason: 'burn box: rule 1001' }]);
        // The resumed walk re-validates the block the first run halted in, and a crash
        // mid-block or a later walk visits it again.
        const resumed = new DegradeCensus(expectedPath);
        resumed.record(545684, 1, 0, hexToBytes(BURN_TREE));
        resumed.record(545684, 1, 0, hexToBytes(BURN_TREE));
        new DegradeCensus(expectedPath).record(545684, 1, 0, hexToBytes(BURN_TREE));
        expect(observed()).toHaveLength(1);
    });

    it('halts when an entry at this height names an output the block does not have', () => {
        writeExpected([{ height: 545684, txIndex: 1, outputIndex: 0, reason: 'burn box: rule 1001' }]);
        const census = new DegradeCensus(expectedPath);
        // Output counts per transaction; entries at other heights are not this block's.
        expect(() => census.checkExpectedPositions(545684, [3, 1])).not.toThrow();
        expect(() => census.checkExpectedPositions(545683, [])).not.toThrow();
        for (const counts of [[3], [3, 0]]) {
            const he = harnessErrorOf(() => census.checkExpectedPositions(545684, counts));
            expect(he.phase).toBe('census');
            expect(he.code).toBe('census-expected-position-missing');
            expect(he.location).toEqual({ txIndex: 1, outputIndex: 0 });
        }
    });

    it('fails at once when the census directory is missing or not writable', () => {
        const missing = harnessErrorOf(() => new DegradeCensus(join(dir, 'no-such-dir', 'census.json')));
        expect(missing.phase).toBe('census');
        expect(missing.code).toBe('census-dir-unwritable');
        if (process.getuid?.() === 0) return; // root ignores the mode bits
        const readOnly = join(dir, 'read-only');
        mkdirSync(readOnly);
        chmodSync(readOnly, 0o555);
        try {
            expect(harnessErrorOf(() => new DegradeCensus(join(readOnly, 'census.json'))).code)
                .toBe('census-dir-unwritable');
        } finally {
            chmodSync(readOnly, 0o755);
        }
    });

    it('wraps a failed log write as a census error', () => {
        const census = new DegradeCensus(expectedPath);
        mkdirSync(`${expectedPath}.observed.jsonl`); // the log path is now a directory
        const he = harnessErrorOf(() => census.record(545684, 1, 0, hexToBytes(BURN_TREE)));
        expect(he.phase).toBe('census');
        expect(he.code).toBe('census-log-write-failed');
        expect(he.location).toEqual({ txIndex: 1, outputIndex: 0, ergoTreeHex: BURN_TREE });
    });
});
