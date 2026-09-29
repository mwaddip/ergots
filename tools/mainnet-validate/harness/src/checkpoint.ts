/**
 * Checkpoint persistence for the mainnet-validate harness.
 *
 * The harness writes a `checkpoint.json` after every successfully validated
 * block so that an interrupted run can resume at `lastValidatedHeight + 1`.
 * Library versions are stamped on every write — if any of the four
 * `@ergots/*` packages changes between runs, the checkpoint loader can
 * surface a version mismatch to the operator (Open item #2 of the spec).
 *
 * The shape mirrors PLAN.md T7 exactly. All file I/O is synchronous; the
 * harness only checkpoints between blocks, never in a hot loop, so the
 * simpler sync API is fine and avoids racey "is this fsync'd" questions.
 *
 * # On read failure
 *
 * `readCheckpoint` returns `null` ONLY for missing-file (ENOENT). Other
 * failures (parse error, shape error) throw — a corrupted checkpoint must
 * not be silently masked as "no progress yet" because that would re-validate
 * already-validated blocks and discard previous progress.
 *
 * # The walk a checkpoint belongs to
 *
 * A checkpoint records its walk's `--mode` and `--census` (`mode`, `census`),
 * and `assertCheckpointUsable` keeps a run from silently changing either: a
 * checkpoint is only ever continued, by a resume with the same mode and
 * census, and never replaced. So the checks a walk ran are the same from its
 * first block to its last. Checkpoints written before these fields existed
 * count as an oracle walk with no census (`walkOf`).
 */

import { readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { HarnessMode } from './cli.js';

/** Persisted progress record. Shape updated in 2j-rest (T9): shimPath/storePath → nodeUrl/indexerUrl. */
export interface Checkpoint {
    /** Height of the most recent block that fully validated. Resume at +1. */
    lastValidatedHeight: number;
    /** Tip height observed when the run started (drives end condition). */
    tipHeightAtStart: number;
    /** ISO 8601 timestamp of the last successful block. */
    lastValidatedAt: string;
    /** URL of the ergo-node REST surface used by this run. */
    nodeUrl: string;
    /** URL of the indexer REST surface used by this run. */
    indexerUrl: string;
    /** Versions of the four @ergots/* packages in use; used for mismatch detection. */
    libraryVersions: {
        scorex: string;
        nipopow: string;
        avltree: string;
        ergoscript: string;
    };
    /** Aggregate counters covering the lifetime of this checkpoint. */
    stats: {
        totalBlocks: number;
        totalTxs: number;
        totalBoxesValidated: number;
        totalSpendsValidated: number;
        /** ISO 8601 timestamp of the FIRST `writeCheckpoint` call in this run. */
        startedAt: string;
        elapsedMs: number;
    };
    /** Set when the harness catches up to `tipHeightAtStart`; absent until then. */
    tipReachedAt?: string;
    /**
     * The walk's `--mode`. Absent in a checkpoint written before 2026-09-29, which counts as
     * `'oracle'` (`walkOf`). The harness always writes it.
     */
    mode?: HarnessMode;
    /**
     * The walk's `--census` expected file as an absolute path, or `null` for a walk without a
     * census. Absent in a checkpoint written before 2026-09-29, which counts as `null`
     * (`walkOf`). The harness always writes it.
     */
    census?: string | null;
}

/**
 * Read and parse a checkpoint file. Returns `null` ONLY if the file does
 * not exist (ENOENT). Any other failure — JSON parse error, malformed
 * shape — throws so the caller cannot silently lose progress.
 */
export function readCheckpoint(path: string): Checkpoint | null {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (err) {
        if (isNodeErrnoException(err) && err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    return validateCheckpoint(parsed, path);
}

/**
 * Atomically write a checkpoint to `path`. Serializes with 2-space
 * indentation for human readability; the file is small (~500 bytes).
 *
 * Atomicity: write to `<path>.tmp` then rename. `rename(2)` is atomic on
 * the same filesystem, so a crash mid-write cannot produce a partially
 * written checkpoint that would later fail `JSON.parse`.
 */
export function writeCheckpoint(path: string, c: Checkpoint): void {
    const tmp = `${path}.tmp`;
    const body = `${JSON.stringify(c, null, 2)}\n`;
    writeFileSync(tmp, body, 'utf8');
    // Atomic replace on POSIX via rename(2); the harness targets Linux/macOS.
    renameSync(tmp, path);
}

/**
 * Remove the checkpoint file. Idempotent: silently succeeds if the file
 * was already absent (ENOENT). Other errors propagate.
 */
export function deleteCheckpoint(path: string): void {
    try {
        unlinkSync(path);
    } catch (err) {
        if (isNodeErrnoException(err) && err.code === 'ENOENT') {
            return;
        }
        throw err;
    }
}

/** The walk a checkpoint belongs to: its `--mode`, and its census as an absolute path or `null`. */
export interface Walk {
    mode: HarnessMode;
    census: string | null;
}

/**
 * The walk `c` belongs to. A checkpoint written before `mode` and `census` existed counts as an
 * oracle walk with no census.
 */
export function walkOf(c: Checkpoint): Walk {
    return { mode: c.mode ?? 'oracle', census: c.census ?? null };
}

/**
 * Refuses a run that would silently change a walk's checks or replace its checkpoint. A
 * checkpoint is only ever continued:
 *   - `--start-height` starts a new walk, so it needs a checkpoint path with no checkpoint on it
 *     (a fresh `--checkpoint-path`, or the old file removed by hand);
 *   - a resume (no `--start-height`) must keep the walk's `--mode` and `--census`, so the checks
 *     a walk ran are the same from its first block to its last.
 *
 * `run.census` is the run's census as an absolute path, or `null`. Throws an `Error` that says
 * how to proceed; `main` treats it as a setup failure.
 */
export function assertCheckpointUsable(
    existing: Checkpoint | null,
    path: string,
    run: Walk & { startHeight?: number },
): void {
    if (existing === null) return;
    const walk = walkOf(existing);
    const theWalk =
        `the walk checkpointed at ${path} (--mode ${walk.mode}, census ${walk.census ?? 'none'}, ` +
        `last validated h=${existing.lastValidatedHeight})`;
    const startNew = 'to start a new walk, pass a fresh --checkpoint-path with --start-height';
    if (run.startHeight !== undefined) {
        throw new Error(
            `--start-height starts a new walk, which would overwrite ${theWalk}: pass a fresh ` +
                `--checkpoint-path (or remove ${path}), or omit --start-height to resume that walk`,
        );
    }
    if (run.mode !== walk.mode) {
        throw new Error(
            `a resume keeps its walk's mode: ${theWalk} ran --mode ${walk.mode}, and this run asks ` +
                `for --mode ${run.mode}; ${startNew}`,
        );
    }
    if (run.census !== walk.census) {
        throw new Error(
            `a resume keeps its walk's census: ${theWalk} ran with census ${walk.census ?? 'none'}, ` +
                `and this run asks for census ${run.census ?? 'none'}; ${startNew}`,
        );
    }
}

/**
 * Read the four `@ergots/*` package.json files and return their `version`
 * fields. Called at the start of every harness run so that the checkpoint
 * carries an accurate version stamp.
 *
 * The path is resolved relative to this module's compiled location (which
 * is symmetric in source and dist) by walking up to the repo root from
 * `tools/mainnet-validate/harness/{src,dist}` and into `packages/<name>`.
 * Throws if any package.json is missing, unparseable, or lacks a string
 * `version` — a missing version is a project-setup bug, not a runtime
 * condition we should silently paper over.
 */
export function currentLibraryVersions(): Checkpoint['libraryVersions'] {
    return {
        scorex: readPackageVersion('scorex'),
        nipopow: readPackageVersion('nipopow'),
        avltree: readPackageVersion('avltree'),
        ergoscript: readPackageVersion('ergoscript'),
    };
}

/**
 * Resolve the absolute path to `packages/<name>/package.json` from this
 * module's filesystem location. Works for both src/ (ts-node / vitest)
 * and dist/ (built `node dist/main.js`) because both sit at the same
 * depth: `tools/mainnet-validate/harness/{src,dist}/checkpoint.{ts,js}`.
 */
function readPackageVersion(name: 'scorex' | 'nipopow' | 'avltree' | 'ergoscript'): string {
    const here = dirname(fileURLToPath(import.meta.url));
    // here = .../tools/mainnet-validate/harness/{src,dist}
    // Go up 4 levels to reach repo root (harness → mainnet-validate → tools → ergots),
    // then down into packages/<name>.
    const pkgJsonPath = join(here, '..', '..', '..', '..', 'packages', name, 'package.json');
    const raw = readFileSync(pkgJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
        throw new Error(`packages/${name}/package.json: not an object`);
    }
    const version = (parsed as Record<string, unknown>)['version'];
    if (typeof version !== 'string' || version.length === 0) {
        throw new Error(`packages/${name}/package.json: missing or non-string \`version\``);
    }
    return version;
}

/** Narrow `unknown` to `NodeJS.ErrnoException` for `.code` access. */
function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
    return err instanceof Error && 'code' in err;
}

/**
 * Validate the JSON-parsed payload as a `Checkpoint`. Throws on any
 * structural mismatch with a path-prefixed error so debugging a malformed
 * checkpoint shows the exact field, not just "expected object".
 */
function validateCheckpoint(raw: unknown, sourcePath: string): Checkpoint {
    const ctx = `checkpoint at ${sourcePath}`;
    if (raw === null || typeof raw !== 'object') {
        throw new Error(`${ctx}: top-level must be an object, got ${typeof raw}`);
    }
    const r = raw as Record<string, unknown>;

    // REJECT pre-REST checkpoints (per spec §8): shimPath/storePath presence
    // indicates this checkpoint was written by the pre-REST harness. Loud
    // failure is correct — silent warn-and-continue would risk stale-resume
    // from a wrong state. Per [[feedback-correctness-over-effort]].
    if ('shimPath' in r || 'storePath' in r) {
        throw new Error(
            `${ctx}: pre-REST checkpoint detected (shimPath/storePath fields present). ` +
            `This harness is the REST-based 2j-rest architecture. Delete the checkpoint ` +
            `file, or pass a fresh --checkpoint-path.`,
        );
    }

    const lastValidatedHeight = requireInt(r['lastValidatedHeight'], `${ctx}.lastValidatedHeight`);
    const tipHeightAtStart = requireInt(r['tipHeightAtStart'], `${ctx}.tipHeightAtStart`);
    const lastValidatedAt = requireString(r['lastValidatedAt'], `${ctx}.lastValidatedAt`);
    const nodeUrl = requireString(r['nodeUrl'], `${ctx}.nodeUrl`);
    const indexerUrl = requireString(r['indexerUrl'], `${ctx}.indexerUrl`);

    const libVersionsRaw = r['libraryVersions'];
    if (libVersionsRaw === null || typeof libVersionsRaw !== 'object') {
        throw new Error(`${ctx}.libraryVersions: must be an object`);
    }
    const lv = libVersionsRaw as Record<string, unknown>;
    const libraryVersions: Checkpoint['libraryVersions'] = {
        scorex: requireString(lv['scorex'], `${ctx}.libraryVersions.scorex`),
        nipopow: requireString(lv['nipopow'], `${ctx}.libraryVersions.nipopow`),
        avltree: requireString(lv['avltree'], `${ctx}.libraryVersions.avltree`),
        ergoscript: requireString(lv['ergoscript'], `${ctx}.libraryVersions.ergoscript`),
    };

    const statsRaw = r['stats'];
    if (statsRaw === null || typeof statsRaw !== 'object') {
        throw new Error(`${ctx}.stats: must be an object`);
    }
    const s = statsRaw as Record<string, unknown>;
    const stats: Checkpoint['stats'] = {
        totalBlocks: requireInt(s['totalBlocks'], `${ctx}.stats.totalBlocks`),
        totalTxs: requireInt(s['totalTxs'], `${ctx}.stats.totalTxs`),
        totalBoxesValidated: requireInt(s['totalBoxesValidated'], `${ctx}.stats.totalBoxesValidated`),
        totalSpendsValidated: requireInt(s['totalSpendsValidated'], `${ctx}.stats.totalSpendsValidated`),
        startedAt: requireString(s['startedAt'], `${ctx}.stats.startedAt`),
        elapsedMs: requireInt(s['elapsedMs'], `${ctx}.stats.elapsedMs`),
    };

    const out: Checkpoint = {
        lastValidatedHeight, tipHeightAtStart, lastValidatedAt,
        nodeUrl, indexerUrl, libraryVersions, stats,
    };
    const tipReachedRaw = r['tipReachedAt'];
    if (tipReachedRaw !== undefined) {
        out.tipReachedAt = requireString(tipReachedRaw, `${ctx}.tipReachedAt`);
    }
    const modeRaw = r['mode'];
    if (modeRaw !== undefined) {
        if (modeRaw !== 'oracle' && modeRaw !== 'lib' && modeRaw !== 'ids') {
            throw new Error(`${ctx}.mode: expected "oracle", "lib" or "ids", got ${String(modeRaw)}`);
        }
        out.mode = modeRaw;
    }
    const censusRaw = r['census'];
    if (censusRaw !== undefined) {
        out.census = censusRaw === null ? null : requireString(censusRaw, `${ctx}.census`);
    }
    return out;
}

function requireInt(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${path}: expected integer, got ${typeof value} (${String(value)})`);
    }
    return value;
}

function requireString(value: unknown, path: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${path}: expected string, got ${typeof value} (${String(value)})`);
    }
    return value;
}
