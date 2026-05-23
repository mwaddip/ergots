/**
 * Repeated-arm detector for the 2j-b autonomous fix-loop.
 *
 * Pure function over a `LoopLogEntry[]` that surfaces "same arm fixed N
 * times" patterns. The orchestrator runs this after each iteration's log
 * append; if `tripped === true`, the loop halts with
 * `'repeated-arm-tripped'` so a human can drive deeper investigation.
 *
 * Canonical arm-name policy: per the spec §"Canonical arm names policy",
 * `diagnosis.proposedFix.affectedArm` uses Discipline A (source-file
 * basename without `.ts`). The detector treats arm names as exact strings;
 * the orchestrator is responsible for enforcing the basename discipline
 * upstream.
 */
import type { LoopLogEntry } from './loop-log.js';

export interface DetectorResult {
    /** True iff at least one arm has been "fixed" ≥ threshold times. */
    tripped: boolean;
    /** The arm name that crossed threshold (highest-count if multiple). */
    arm?: string;
    /** Number of iterations that touched this arm. */
    count?: number;
    /** Iteration numbers (in encounter order) that touched the arm. */
    iterations?: number[];
}

/**
 * Detect a repeated-arm pattern across the supplied log.
 *
 * @param log entries from `readLoopLog()` — order matters only for the
 *   `iterations` field of the result (encounter order preserved).
 * @param threshold minimum number of iterations touching the same arm to
 *   trip detection. Default 3 per spec §"Stop signals" (initial; subject to
 *   empirical recalibration per carry-forward VG3). Must be ≥ 1.
 * @returns `{tripped: true, arm, count, iterations}` on first arm at or
 *   above threshold; `{tripped: false}` otherwise. Throws if threshold < 1.
 */
export function detectRepeatedArm(
    log: LoopLogEntry[],
    threshold = 3,
): DetectorResult {
    if (threshold < 1) {
        throw new Error(`detectRepeatedArm: threshold must be >= 1, got ${threshold}`);
    }

    const armToIterations = new Map<string, number[]>();
    for (const entry of log) {
        const arm = entry.diagnosis.proposedFix.affectedArm;
        const existing = armToIterations.get(arm);
        if (existing === undefined) {
            armToIterations.set(arm, [entry.iteration]);
        } else {
            existing.push(entry.iteration);
        }
    }

    // If multiple arms cross threshold, return the one with the HIGHEST
    // count (most pressing signal). Ties broken by first-encountered.
    let best: DetectorResult = { tripped: false };
    for (const [arm, iters] of armToIterations) {
        if (iters.length >= threshold) {
            if (!best.tripped || iters.length > (best.count ?? 0)) {
                best = {
                    tripped: true,
                    arm,
                    count: iters.length,
                    iterations: iters,
                };
            }
        }
    }
    return best;
}
