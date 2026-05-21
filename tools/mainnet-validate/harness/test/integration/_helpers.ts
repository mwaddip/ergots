/**
 * Shared helpers for the harness integration tests under
 * `test/integration/`.
 *
 * The integration tests spawn the built harness (`node dist/main.js`) as a
 * subprocess, which in turn spawns the Rust shim. To keep the tests
 * deterministic and CI-friendly we:
 *
 *   1. Check on disk for the harness `dist/main.js`, the shim binary, and
 *      (for some tests) a real modifier-store fixture. If any required
 *      asset is missing, the test reports the skip explicitly via
 *      `it.skip(...)` so the absence shows in the vitest output instead of
 *      silently passing.
 *
 *   2. Run each subprocess to completion (no streaming assertions). The
 *      harness's halt-on-first-failure semantics + the small `--max-height`
 *      caps we pass mean every run terminates within a couple of seconds
 *      against the local 25 GB fixture, well under the 30 s per-test
 *      timeout configured in `vitest.config.ts`. No sleeps, no retries —
 *      either the run completes deterministically or the test fails.
 *
 *   3. Allocate per-test scratch paths under `os.tmpdir()` with a unique
 *      prefix (`ergots-t13-<test-name>-`) and clean them up in `afterEach`
 *      so reruns are independent. The on-disk modifier store is mounted
 *      read-only by the shim, so writing to it from these tests is not a
 *      concern.
 *
 * # Why subprocess-spawn (not unit mock)?
 *
 * Per the T13 spec (Layer 4/5/6 paths), the tests exercise the harness's
 * orchestration layer: argv parsing, checkpoint resume math, error-report
 * sidecar writes, exit codes, and stderr-vs-stdout discipline. A mocked
 * `ShimClient` would replace the integration boundary the tests are
 * trying to validate.
 *
 * # Fixture path resolution
 *
 * The default mainnet-store fixture is a 25 GB redb copy at
 * `/tmp/ergots-2j-pre-smoke-data/modifiers.redb` (see T12 notes). It is
 * not committed and not present on every machine. Tests that need it
 * detect its absence and skip. The `ERGOTS_T13_STORE_PATH` env var can
 * override the default if the local copy lives elsewhere.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-root absolute path, computed from this file's location. */
const HERE = dirname(fileURLToPath(import.meta.url));
// test/integration -> test -> harness -> mainnet-validate -> tools -> ergots
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');

/** Path to the built harness entry script. Requires `npm run build`. */
export const HARNESS_DIST_MAIN = join(
    REPO_ROOT,
    'tools',
    'mainnet-validate',
    'harness',
    'dist',
    'main.js',
);

/**
 * Path to the built Rust shim binary. Matches the CLI default in
 * `src/cli.ts` (kept in sync — if the default moves, this MUST move too).
 */
export const SHIM_BINARY = join(
    REPO_ROOT,
    'tools',
    'mainnet-validate',
    'shim',
    'target',
    'release',
    'ergots-mainnet-validate-shim',
);

/**
 * Default real-data fixture (mainnet modifiers.redb copy). Overrideable
 * via `ERGOTS_T13_STORE_PATH` for non-standard local layouts.
 */
export const DEFAULT_FIXTURE_STORE =
    process.env['ERGOTS_T13_STORE_PATH'] ??
    '/tmp/ergots-2j-pre-smoke-data/modifiers.redb';

/**
 * Determine whether the prerequisite assets for a real-data integration
 * test are present. Returns `null` if everything is in place; otherwise
 * a human-readable reason for the skip.
 */
export function checkRealDataPrereqs(): string | null {
    if (!existsSync(HARNESS_DIST_MAIN)) {
        return `harness dist missing (${HARNESS_DIST_MAIN}); run \`npm run build\``;
    }
    if (!existsSync(SHIM_BINARY)) {
        return `shim binary missing (${SHIM_BINARY}); run \`cargo build --release\` in tools/mainnet-validate/shim`;
    }
    if (!existsSync(DEFAULT_FIXTURE_STORE)) {
        return `fixture store missing (${DEFAULT_FIXTURE_STORE}); set ERGOTS_T13_STORE_PATH or copy a mainnet redb here`;
    }
    // Sanity: ensure the fixture is a file (not a directory). A symlink to
    // a missing target would have failed `existsSync` already.
    const st = statSync(DEFAULT_FIXTURE_STORE);
    if (!st.isFile()) {
        return `fixture store is not a regular file: ${DEFAULT_FIXTURE_STORE}`;
    }
    return null;
}

/**
 * Lighter prereqs check for the halt-path startup test, which doesn't
 * need a real fixture (it points the shim at a fresh empty redb path
 * the shim auto-creates).
 */
export function checkStartupOnlyPrereqs(): string | null {
    if (!existsSync(HARNESS_DIST_MAIN)) {
        return `harness dist missing (${HARNESS_DIST_MAIN}); run \`npm run build\``;
    }
    if (!existsSync(SHIM_BINARY)) {
        return `shim binary missing (${SHIM_BINARY}); run \`cargo build --release\` in tools/mainnet-validate/shim`;
    }
    return null;
}

/** Per-test scratch directory under `os.tmpdir()`, auto-cleaned in `afterEach`. */
export interface ScratchDir {
    path: string;
    cleanup(): void;
}

/**
 * Create an isolated scratch directory for a test. The caller composes
 * sidecar / checkpoint / error-report paths inside it. Calling `cleanup()`
 * removes the entire directory (recursive + force, idempotent).
 */
export function makeScratchDir(testName: string): ScratchDir {
    const dir = mkdtempSync(join(tmpdir(), `ergots-t13-${testName}-`));
    return {
        path: dir,
        cleanup(): void {
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Captured outcome of a harness subprocess invocation. */
export interface HarnessRun {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
}

/**
 * Spawn the built harness with the given argv and await its exit.
 *
 * The harness inherits no stdio from the parent — stdout/stderr are
 * captured and returned as strings. Stdin is closed immediately (the
 * harness reads no user input).
 *
 * # Why a hard timeout instead of relying on vitest's per-test timeout?
 *
 * The vitest timeout aborts the test runner's promise but does not
 * reliably kill the spawned subprocess (or its descendant shim
 * subprocess). Without an explicit SIGTERM, a hung harness "passes" via
 * vitest timeout while leaking a Rust process that holds the modifier
 * store's redb lock until the parent vitest exits — wedging every
 * subsequent integration test in the run. The SIGTERM here propagates
 * to the harness, whose `finally` block calls `shim.close()` to release
 * the lock cleanly.
 *
 * The default `timeoutMs` (28 s) sits below the per-test timeout the
 * callers pass to `it(...)` (30-90 s in the current suite), so the
 * SIGTERM fires before vitest gives up on the test promise — that
 * ordering is what guarantees the lock gets released.
 */
export function runHarness(
    args: readonly string[],
    timeoutMs = 28_000,
): Promise<HarnessRun> {
    return new Promise<HarnessRun>((resolveRun, rejectRun) => {
        const proc = spawn('node', [HARNESS_DIST_MAIN, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        const killTimer = setTimeout(() => {
            // SIGTERM lets the harness propagate to the shim cleanly.
            proc.kill('SIGTERM');
        }, timeoutMs);
        proc.on('error', (err) => {
            clearTimeout(killTimer);
            rejectRun(err);
        });
        proc.on('exit', (code, signal) => {
            clearTimeout(killTimer);
            resolveRun({ exitCode: code, signal, stdout, stderr });
        });
    });
}
