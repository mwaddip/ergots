/**
 * Unit tests for `checkpoint.ts`. Covers:
 *   1. Missing-file read returns `null`.
 *   2. Round-trip write→read preserves structural equality.
 *   3. `deleteCheckpoint` removes the file and is idempotent when missing.
 *   4. `currentLibraryVersions` returns non-empty strings for all 4 packages.
 *   5. Optional `tipReachedAt` survives the round trip.
 *   6. Corrupt JSON throws (does NOT silently return null).
 *   7. Shape mismatch on read throws with a useful path-prefixed message.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    readCheckpoint,
    writeCheckpoint,
    deleteCheckpoint,
    currentLibraryVersions,
    type Checkpoint,
} from '../src/checkpoint.js';

function makeSampleCheckpoint(): Checkpoint {
    return {
        lastValidatedHeight: 1234,
        tipHeightAtStart: 1790510,
        lastValidatedAt: '2026-05-22T12:00:00.000Z',
        shimPath: '/abs/path/to/shim',
        storePath: '/abs/path/to/store.redb',
        libraryVersions: {
            scorex: '0.1.0',
            nipopow: '0.2.0',
            avltree: '0.2.0',
            ergoscript: '0.2.0',
        },
        stats: {
            totalBlocks: 1234,
            totalTxs: 5678,
            totalBoxesValidated: 9012,
            totalSpendsValidated: 3456,
            startedAt: '2026-05-22T11:00:00.000Z',
            elapsedMs: 3_600_000,
        },
    };
}

describe('checkpoint', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ergots-checkpoint-test-'));
        path = join(dir, 'checkpoint.json');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('readCheckpoint returns null when the file does not exist', () => {
        expect(readCheckpoint(path)).toBeNull();
    });

    it('round-trips a checkpoint via write then read', () => {
        const c = makeSampleCheckpoint();
        writeCheckpoint(path, c);
        const read = readCheckpoint(path);
        expect(read).toEqual(c);
    });

    it('preserves the optional tipReachedAt field across the round trip', () => {
        const c = makeSampleCheckpoint();
        c.tipReachedAt = '2026-05-22T13:00:00.000Z';
        writeCheckpoint(path, c);
        const read = readCheckpoint(path);
        expect(read?.tipReachedAt).toBe('2026-05-22T13:00:00.000Z');
    });

    it('writes a pretty-printed file with a trailing newline', () => {
        const c = makeSampleCheckpoint();
        writeCheckpoint(path, c);
        const raw = readFileSync(path, 'utf8');
        expect(raw.endsWith('\n')).toBe(true);
        // 2-space indent → multi-line. Sanity-check: not on a single line.
        expect(raw.split('\n').length).toBeGreaterThan(5);
    });

    it('deleteCheckpoint removes the file when it exists', () => {
        writeCheckpoint(path, makeSampleCheckpoint());
        expect(existsSync(path)).toBe(true);
        deleteCheckpoint(path);
        expect(existsSync(path)).toBe(false);
    });

    it('deleteCheckpoint is idempotent when the file is missing', () => {
        expect(existsSync(path)).toBe(false);
        expect(() => deleteCheckpoint(path)).not.toThrow();
    });

    it('readCheckpoint throws on corrupted JSON (does not return null)', () => {
        writeFileSync(path, '{not valid json', 'utf8');
        expect(() => readCheckpoint(path)).toThrow();
    });

    it('readCheckpoint throws with a path-prefixed message on shape mismatch', () => {
        const bad = { lastValidatedHeight: 'not a number' };
        writeFileSync(path, JSON.stringify(bad), 'utf8');
        expect(() => readCheckpoint(path)).toThrow(/lastValidatedHeight/);
    });

    it('readCheckpoint throws on missing libraryVersions branch', () => {
        const bad: Record<string, unknown> = {
            ...makeSampleCheckpoint(),
            libraryVersions: { scorex: '0.1.0' /* missing 3 others */ },
        };
        writeFileSync(path, JSON.stringify(bad), 'utf8');
        expect(() => readCheckpoint(path)).toThrow(/libraryVersions/);
    });
});

describe('currentLibraryVersions', () => {
    it('returns non-empty version strings for all 4 ergots packages', () => {
        const v = currentLibraryVersions();
        expect(typeof v.scorex).toBe('string');
        expect(v.scorex.length).toBeGreaterThan(0);
        expect(typeof v.nipopow).toBe('string');
        expect(v.nipopow.length).toBeGreaterThan(0);
        expect(typeof v.avltree).toBe('string');
        expect(v.avltree.length).toBeGreaterThan(0);
        expect(typeof v.ergoscript).toBe('string');
        expect(v.ergoscript.length).toBeGreaterThan(0);
    });

    it('returned versions match a SemVer-shaped pattern', () => {
        const v = currentLibraryVersions();
        const semverish = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
        expect(v.scorex).toMatch(semverish);
        expect(v.nipopow).toMatch(semverish);
        expect(v.avltree).toMatch(semverish);
        expect(v.ergoscript).toMatch(semverish);
    });
});
