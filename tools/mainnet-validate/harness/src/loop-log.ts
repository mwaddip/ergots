/**
 * Loop log writer for the 2j-b autonomous fix-loop infrastructure.
 *
 * Each iteration of the loop appends ONE structured entry capturing the
 * halt site, the diagnosis subagent's analysis, the fix subagent's outcome,
 * and the post-fix smoke result. The file is the empirical inventory used
 * by post-hoc pattern detection (per the 2j-b spec §"Log format").
 *
 * The writer uses an mtime-guarded atomic write to detect external editor
 * races (M2 finding from reviewer pass v2). The `appendLoopLogEntry` flow
 * is: stat → read → parse → push → stat-recheck → write-tmp → rename. If
 * the file's mtime changed between the first and second stat, an external
 * process raced us and the write throws — the orchestrator catches this as
 * a `'log-append-failure'` stop signal.
 */
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import type { ErrorPhase } from './error-report.js';

/**
 * One entry per loop iteration. Shape mirrors the spec's example log entry
 * with the four major sections: `halt` (from `error-report.json`),
 * `diagnosis` (from info-gather subagent), `fix` (from fix-apply subagent),
 * `smokeResult` (back-filled by the orchestrator on the NEXT iteration or
 * on terminal state).
 */
export interface LoopLogEntry {
    /** 1-based iteration counter. iter-0 reserved for T6 calibration probe. */
    iteration: number;
    /** ISO 8601 timestamp when the orchestrator created the entry. */
    timestamp: string;

    /** Structured halt extracted from `error-report.json`. */
    halt: {
        height: number;
        phase: ErrorPhase;
        errorCode?: string;
        location: {
            txIndex?: number;
            txId?: string;
            inputIndex?: number;
            outputIndex?: number;
            spentBoxId?: string;
            ergoTreeHex?: string;
        };
        /** Present when phase === 'evaluate-cost'. */
        evaluateCost?: { expected: number; actual: number; delta: number };
    };

    /** Info-gather subagent output (DiagnosisOutput in the spec). */
    diagnosis: {
        rootCause: string;
        sigmaRustCites: Array<{ path: string; line: number; snippet: string }>;
        ourCodeCites: Array<{ path: string; line: number; snippet: string }>;
        proposedFix: {
            summary: string;
            affectedArm: string;
            expectedCostDelta?: number;
            filesToTouch: string[];
        };
        redFixtureSpec: {
            fixturePath: string;
            inputDescription: string;
            expectedValue: string;
            expectedCost: number;
        };
        confidence: number;
        uncertaintySources: string[];
    };

    /** Fix-apply subagent output (FixOutput in the spec). */
    fix: {
        outcome: 'SUCCESS' | 'FAILURE';
        overridesEcho: string;
        testCountBefore: number;
        testCountAfter: number;
        commitSha?: string;
        filesChanged?: string[];
        regressionTestPath?: string;
        diffStat?: { added: number; removed: number };
        failureReason?: string;
        failureLog?: string;
    };

    /** Back-filled by the orchestrator on the NEXT iteration or terminal state. */
    smokeResult: {
        walkedFromHeight: number;
        walkedToHeight: number | null;
        outcome: 'halt' | 'tip-reached' | 'max-height' | 'pending';
    };
}

export const DEFAULT_LOOP_LOG_PATH = 'tools/mainnet-validate/findings/loop-log.json';

/**
 * Thrown when `appendLoopLogEntry` detects an external write race (file
 * mtime changed between read and write). Distinct error class so the
 * orchestrator can dispatch on it as `'log-append-failure'`.
 */
export class LoopLogExternalModificationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LoopLogExternalModificationError';
    }
}

/**
 * Append a new entry to the loop log file. Uses mtime-guarded atomic write.
 *
 * If the file does not exist (ENOENT), it is created with `[entry]`. Any
 * other read error propagates. After the existing array is parsed and the
 * new entry pushed, the file's mtime is re-checked; if it changed between
 * the first stat and the re-stat, the write is aborted with
 * `LoopLogExternalModificationError` (the orchestrator catches this).
 *
 * Atomicity: write to `<path>.tmp` then `rename` — same pattern as
 * `writeCheckpoint`. The rename is atomic on the same filesystem.
 */
export function appendLoopLogEntry(
    entry: LoopLogEntry,
    path: string = DEFAULT_LOOP_LOG_PATH,
): void {
    let existing: LoopLogEntry[] = [];
    let mtimeBefore: number | null = null;
    try {
        const st = statSync(path);
        mtimeBefore = st.mtimeMs;
        existing = JSON.parse(readFileSync(path, 'utf8')) as LoopLogEntry[];
        if (!Array.isArray(existing)) {
            throw new Error(`${path}: not a JSON array (got ${typeof existing})`);
        }
    } catch (err) {
        if (!isNodeErrnoException(err) || err.code !== 'ENOENT') {
            throw err;
        }
    }

    existing.push(entry);

    // Mtime re-check ONLY makes sense if the file existed at read time.
    if (mtimeBefore !== null) {
        const stAfter = statSync(path);
        if (stAfter.mtimeMs !== mtimeBefore) {
            throw new LoopLogExternalModificationError(
                `${path}: mtime changed during append (${mtimeBefore} → ${stAfter.mtimeMs}); external edit detected`,
            );
        }
    }

    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
}

/**
 * Read the entire loop log. Returns `[]` if the file does not exist.
 * Throws on JSON parse failure or non-ENOENT read error.
 */
export function readLoopLog(
    path: string = DEFAULT_LOOP_LOG_PATH,
): LoopLogEntry[] {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!Array.isArray(parsed)) {
            throw new Error(`${path}: not a JSON array (got ${typeof parsed})`);
        }
        return parsed as LoopLogEntry[];
    } catch (err) {
        if (isNodeErrnoException(err) && err.code === 'ENOENT') {
            return [];
        }
        throw err;
    }
}

function isNodeErrnoException(e: unknown): e is NodeJS.ErrnoException {
    return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === 'string';
}
