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
 *   - a listed output whose tree parses halts with `'census-expected-degrade-missing'`;
 *   - a listed position the block at its height does not have halts with
 *     `'census-expected-position-missing'`.
 *
 * Every observed degrade is appended to `<path>.observed.jsonl`, listed or not, before any halt,
 * once: keys the log already holds are not written again, so a resume, a crash mid-block or a
 * later walk that visits the output again does not repeat the line.
 *
 * File trouble is a census error (`HarnessError('census', …)`): the constructor fails at once
 * when the census directory is missing or not writable (`'census-dir-unwritable'`), or when the
 * expected file or the log cannot be read (`'census-file-unreadable'`) or is malformed
 * (`'census-file-malformed'`); a failed log write halts the walk (`'census-log-write-failed'`).
 *
 * The expected file and the observed log are run artifacts: they are not committed.
 */

import { accessSync, appendFileSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
    private readonly expectedByHeight: Map<number, CensusEntry[]>;
    /** Keys the observed log already holds. */
    private readonly logged: Set<string>;
    private readonly logPath: string;

    /**
     * Reads the expected file at `path` (a missing file means no degrade is expected yet) and the
     * keys its observed log already holds. Throws a census `HarnessError` for a census directory
     * that is missing or not writable, and for a census file that cannot be read or is malformed.
     */
    constructor(path: string) {
        this.logPath = `${path}.observed.jsonl`;
        requireWritableDir(dirname(resolve(path)), this.logPath);
        const entries = parseEntries(readJsonFile(path), path);
        this.expected = new Set(entries.map((e) => keyOf(e.height, e.txIndex, e.outputIndex)));
        this.expectedByHeight = new Map();
        for (const e of entries) {
            const atHeight = this.expectedByHeight.get(e.height);
            if (atHeight === undefined) this.expectedByHeight.set(e.height, [e]);
            else atHeight.push(e);
        }
        this.logged = readLoggedKeys(this.logPath);
    }

    /** The number of distinct positions the census expects to degrade. */
    get expectedCount(): number {
        return this.expected.size;
    }

    /**
     * Checks one output tree against the census. `ergoTreeBytes` must be the instance the box
     * parse produced, so that `boxTreeOf` returns the tree box ingest parsed for it (a copy is a
     * cache miss, parsed standalone).
     */
    record(height: number, txIndex: number, outputIndex: number, ergoTreeBytes: Uint8Array): void {
        const key = keyOf(height, txIndex, outputIndex);
        const tree = boxTreeOf(ergoTreeBytes);
        if (!isUnparsedTree(tree)) {
            if (this.expected.has(key)) {
                throw new HarnessError(
                    'census',
                    'census-expected-degrade-missing',
                    `output tree at ${key} parses, but the census expects it to degrade`,
                    { txIndex, outputIndex, ergoTreeHex: bytesToHex(ergoTreeBytes) },
                );
            }
            return;
        }
        // The hex is built only on the log and halt paths: `record` runs for every output tree.
        const location = { txIndex, outputIndex, ergoTreeHex: bytesToHex(ergoTreeBytes) };
        if (!this.logged.has(key)) {
            const line = JSON.stringify({ height, txIndex, outputIndex, error: tree.error.message, ergoTreeHex: location.ergoTreeHex });
            try {
                appendFileSync(this.logPath, `${line}\n`);
            } catch (err) {
                throw new HarnessError(
                    'census',
                    'census-log-write-failed',
                    `appending ${key} to the census log ${this.logPath} failed: ${messageOf(err)}`,
                    location,
                );
            }
            this.logged.add(key);
        }
        if (!this.expected.has(key)) {
            throw new HarnessError(
                'census',
                'census-unexpected-degrade',
                `output tree degraded at ${key}: ${tree.error.message}`,
                location,
            );
        }
    }

    /**
     * Checks that every expected entry at `height` names an output the block has;
     * `outputCounts[i]` is transaction i's output count. `record` sees only outputs that exist,
     * so an entry naming any other position would otherwise never be checked. The check is per
     * block, so it holds across resumes.
     */
    checkExpectedPositions(height: number, outputCounts: readonly number[]): void {
        for (const e of this.expectedByHeight.get(height) ?? []) {
            const outputs = outputCounts[e.txIndex];
            if (outputs === undefined || e.outputIndex >= outputs) {
                const has = outputs === undefined
                    ? `${outputCounts.length} transactions`
                    : `${outputs} outputs in transaction ${e.txIndex}`;
                throw new HarnessError(
                    'census',
                    'census-expected-position-missing',
                    `census entry ${keyOf(e.height, e.txIndex, e.outputIndex)} (${e.reason}) names an output ` +
                        `block ${height} does not have: it has ${has}`,
                    { txIndex: e.txIndex, outputIndex: e.outputIndex },
                );
            }
        }
    }
}

function keyOf(height: number, txIndex: number, outputIndex: number): string {
    return `${height}:${txIndex}:${outputIndex}`;
}

function isIndex(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Fails now, not at the first degrade, when the observed log could not be written. */
function requireWritableDir(dir: string, logPath: string): void {
    try {
        if (!statSync(dir).isDirectory()) throw new Error('not a directory');
        accessSync(dir, constants.W_OK);
        if (existsSync(logPath)) accessSync(logPath, constants.W_OK);
    } catch (err) {
        throw new HarnessError(
            'census',
            'census-dir-unwritable',
            `census directory ${dir} is missing or not writable: ${messageOf(err)}`,
        );
    }
}

/** The expected file's JSON, or an empty list when the file does not exist yet. */
function readJsonFile(path: string): unknown {
    if (!existsSync(path)) return [];
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch (err) {
        throw new HarnessError('census', 'census-file-unreadable', `census file ${path}: ${messageOf(err)}`);
    }
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new HarnessError('census', 'census-file-malformed', `census file ${path} is not valid JSON: ${messageOf(err)}`);
    }
}

/** Validates the expected file's shape: an array of entries, each with its position and reason. */
function parseEntries(list: unknown, path: string): CensusEntry[] {
    const malformed = (message: string): HarnessError =>
        new HarnessError('census', 'census-file-malformed', `census file ${path} ${message}`);
    if (!Array.isArray(list)) {
        throw malformed('must hold a JSON array of entries');
    }
    return list.map((raw: unknown, i) => {
        const e = (raw ?? {}) as Partial<Record<keyof CensusEntry, unknown>>;
        for (const field of ['height', 'txIndex', 'outputIndex'] as const) {
            if (!isIndex(e[field])) {
                throw malformed(`entry ${i}: ${field} must be a non-negative integer`);
            }
        }
        if (typeof e.reason !== 'string' || e.reason.length === 0) {
            throw malformed(`entry ${i}: reason must justify the degrade`);
        }
        return e as CensusEntry;
    });
}

/** The keys the observed log already holds, so that no degrade is logged twice. */
function readLoggedKeys(logPath: string): Set<string> {
    const keys = new Set<string>();
    if (!existsSync(logPath)) return keys;
    let text: string;
    try {
        text = readFileSync(logPath, 'utf8');
    } catch (err) {
        throw new HarnessError('census', 'census-file-unreadable', `census log ${logPath}: ${messageOf(err)}`);
    }
    text.split('\n').forEach((line, i) => {
        if (line.trim() === '') return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (err) {
            throw new HarnessError(
                'census',
                'census-file-malformed',
                `census log ${logPath} line ${i + 1} is not valid JSON: ${messageOf(err)}`,
            );
        }
        const e = (parsed ?? {}) as Partial<Record<'height' | 'txIndex' | 'outputIndex', unknown>>;
        if (!isIndex(e.height) || !isIndex(e.txIndex) || !isIndex(e.outputIndex)) {
            throw new HarnessError(
                'census',
                'census-file-malformed',
                `census log ${logPath} line ${i + 1} lacks its position (height, txIndex, outputIndex)`,
            );
        }
        keys.add(keyOf(e.height, e.txIndex, e.outputIndex));
    });
    return keys;
}

function bytesToHex(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
    return s;
}
