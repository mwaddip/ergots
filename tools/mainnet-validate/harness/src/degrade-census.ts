/**
 * Degrade census for the mainnet walk (spec 2026-09-28 §12, and Tests §4, the merge gate).
 *
 * Under the box rules a size-flagged output tree can degrade to an `UnparsedErgoTree`: rule 1001
 * (a root that does not type as SigmaProp) or any other failure in the soft-fork degrade set
 * (JVM `ErgoTreeSerializer.scala:196-203`). An honest tree never degrades, so a degrade the
 * harness did not expect means ergots mistypes an honest root, or a degrade rule regressed.
 *
 * The census is an expected file, a JSON array of `CensusEntry`, one per known degrade, each
 * with the reason it is expected. The first run starts without the file, so it halts on the
 * first degrade and leaves it in the observed log. The operator justifies each entry and adds
 * it to the expected file. Later runs fail on any difference:
 *   - a degrade the file does not list halts with `'census-unexpected-degrade'`;
 *   - a listed output whose tree parses halts with `'census-expected-degrade-missing'`.
 *
 * Every observed degrade is appended to `<path>.observed.jsonl`, listed or not, before any halt.
 * The expected file and the observed log are run artifacts: they are not committed.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { boxTreeOf, isUnparsedTree } from '@ergots/ergoscript';

import { HarnessError } from './errors.js';

/** One expected degrade: the output's position in the chain and why it degrades. */
export interface CensusEntry {
    height: number;
    txIndex: number;
    outputIndex: number;
    reason: string;
}

export class DegradeCensus {
    private readonly expected: Set<string>;

    /** Reads the expected file at `path`; a missing file means no degrade is expected yet. */
    constructor(private readonly path: string) {
        const list: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
        this.expected = new Set(parseEntries(list, path).map((e) => keyOf(e.height, e.txIndex, e.outputIndex)));
    }

    /**
     * Checks one output tree against the census. `ergoTreeBytes` must be the instance the box
     * parse produced, so that `boxTreeOf` returns the tree box ingest parsed for it (a copy is a
     * cache miss, parsed standalone).
     */
    record(height: number, txIndex: number, outputIndex: number, ergoTreeBytes: Uint8Array): void {
        const key = keyOf(height, txIndex, outputIndex);
        const location = { txIndex, outputIndex, ergoTreeHex: bytesToHex(ergoTreeBytes) };
        const tree = boxTreeOf(ergoTreeBytes);
        if (!isUnparsedTree(tree)) {
            if (this.expected.has(key)) {
                throw new HarnessError(
                    'census',
                    'census-expected-degrade-missing',
                    `output tree at ${key} parses, but the census expects it to degrade`,
                    location,
                );
            }
            return;
        }
        appendFileSync(
            `${this.path}.observed.jsonl`,
            `${JSON.stringify({ height, txIndex, outputIndex, error: tree.error.message, ergoTreeHex: location.ergoTreeHex })}\n`,
        );
        if (!this.expected.has(key)) {
            throw new HarnessError(
                'census',
                'census-unexpected-degrade',
                `output tree degraded at ${key}: ${tree.error.message}`,
                location,
            );
        }
    }
}

function keyOf(height: number, txIndex: number, outputIndex: number): string {
    return `${height}:${txIndex}:${outputIndex}`;
}

/** Validates the expected file's shape: an array of entries, each with its position and reason. */
function parseEntries(list: unknown, path: string): CensusEntry[] {
    if (!Array.isArray(list)) {
        throw new Error(`census file ${path} must hold a JSON array of entries`);
    }
    return list.map((raw: unknown, i) => {
        const e = raw as Partial<Record<keyof CensusEntry, unknown>>;
        for (const field of ['height', 'txIndex', 'outputIndex'] as const) {
            const v = e[field];
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
                throw new Error(`census file ${path} entry ${i}: ${field} must be a non-negative integer`);
            }
        }
        if (typeof e.reason !== 'string' || e.reason.length === 0) {
            throw new Error(`census file ${path} entry ${i}: reason must justify the degrade`);
        }
        return e as CensusEntry;
    });
}

function bytesToHex(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
    return s;
}
