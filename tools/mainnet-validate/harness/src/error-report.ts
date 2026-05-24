/**
 * Error report sidecar for the mainnet-validate harness.
 *
 * When the harness halts on a validation failure, it writes a structured
 * `error-report.json` next to the checkpoint capturing the height, phase,
 * error class, message, an excerpt of the offending bundle (header/tx/box
 * bytes as hex), and any location information available at the failure
 * site. Operators inspect this file to triage; the next run that succeeds
 * past the same height calls `deleteErrorReport` to clear the sidecar.
 *
 * Shape comes from PLAN.md T7 exactly. Sync I/O matches `checkpoint.ts`:
 * we only write on halt (rare, terminal) and delete on next-block success
 * (between blocks, not hot loop).
 *
 * # Why discriminate `phase`?
 *
 * Five distinct validation phases can each fail (see PLAN.md spec Decision
 * 12). Encoding phase as a string-literal union catches typos at the call
 * site and lets downstream tooling filter by phase without parsing free-
 * form error messages.
 */

import { writeFileSync, unlinkSync, renameSync } from 'node:fs';

/**
 * Which validation phase produced the error. Closed union per spec; adding
 * a phase requires updating both this type and the writer call sites.
 *
 * Phase 2j-a added `'evaluate-cost'` and `'evaluate-oracle-mismatch'`, the
 * cost-equivalence sub-step of the evaluate pass. See `EvaluateCostPayload`
 * and `EvaluateOracleMismatchPayload`.
 */
export type ErrorPhase =
    | 'header'
    | 'output-roundtrip'
    | 'evaluate'
    | 'verify-signature'
    | 'node-rest'      // replaces 'shim' for node REST errors
    | 'indexer-rest'   // replaces 'shim' for indexer REST errors
    | 'wasm-oracle'    // replaces 'shim' for WASM oracle errors
    | 'evaluate-cost'
    | 'evaluate-oracle-mismatch';

/**
 * Payload for phase `'evaluate-cost'` (both oracle and our TS evaluator
 * succeeded but disagree on cost). `expected` is the oracle's
 * `ctx.jit_cost_value()`; `actual` is our `ctx.jitCost`; `delta` is
 * `expected - actual` so the sign indicates which side undercharged.
 *
 * Stored as `number` (not `bigint`) because the cost-diff sub-step has
 * already narrowed the oracle's u64 via a `Number.MAX_SAFE_INTEGER`
 * overflow guard, and JSON has no bigint type — keeping `number` here
 * matches the disk shape directly.
 */
export interface EvaluateCostPayload {
    expected: number;
    actual: number;
    delta: number;
}

/**
 * Payload for phase `'evaluate-oracle-mismatch'` (oracle and our TS
 * evaluator disagree on eval success/failure). `code` carries which side
 * errored; `oracleError` / `ourError` are the formatted error messages
 * from each side (null on the side that succeeded); `ourEvaluateCost` is
 * our `ctx.jitCost` at the throw point, present only when
 * `code === 'ours-errored-oracle-succeeded'`.
 *
 * This is the HarnessError payload shape. The disk shape in `ErrorReport`
 * flattens these fields: `code` maps to `ErrorReport.errorCode`; the
 * remaining fields appear as top-level keys (`oracleError`, `ourError`,
 * `ourEvaluateCost`) per the 2j-a JSON schema.
 */
export interface EvaluateOracleMismatchPayload {
    code: 'ours-succeeded-oracle-errored' | 'ours-errored-oracle-succeeded';
    oracleError: string | null;
    ourError: string | null;
    ourEvaluateCost: number | null;
}

/**
 * Structured halt record. Shape from PLAN.md T7 plus the 2j-a additions
 * for the cost-equivalence sub-step (see `evaluateCost`, `oracleError`,
 * `ourError`, `ourEvaluateCost`).
 */
export interface ErrorReport {
    /** ISO 8601 timestamp of the halt. */
    timestamp: string;
    /** Block height at which the failure was detected. */
    height: number;
    /** Which validation phase emitted the error. */
    phase: ErrorPhase;
    /** Class name of the thrown error (e.g. `EvalError`, `VerifyError`, `ShimError`). */
    errorClass: string;
    /** Error code if the error class carries one (e.g. EvalError's 43 codes). */
    errorCode?: string;
    /** Human-readable error message. */
    message: string;
    /** JS stack trace if available — purely diagnostic. */
    stack?: string;
    /**
     * Where in the block the failure happened. All fields optional because
     * phase determines which apply (e.g. `header` phase has no tx/input).
     */
    location: {
        txIndex?: number;
        txId?: string;
        inputIndex?: number;
        outputIndex?: number;
        spentBoxId?: string;
        ergoTreeHex?: string;
    };
    /**
     * Present when `phase === 'evaluate-cost'`. The cost-drift payload
     * captured at the point of disagreement between sigma-rust's oracle
     * and our TS evaluator (after both succeeded).
     */
    evaluateCost?: EvaluateCostPayload;
    /**
     * Present when `phase === 'evaluate-oracle-mismatch'`. The formatted
     * error from sigma-rust's oracle (null if the oracle succeeded and
     * our side errored).
     */
    oracleError?: string | null;
    /**
     * Present when `phase === 'evaluate-oracle-mismatch'`. The formatted
     * error from our TS evaluator (null if our side succeeded and the
     * oracle errored).
     */
    ourError?: string | null;
    /**
     * Present when `phase === 'evaluate-oracle-mismatch'` and `errorCode`
     * is `'ours-errored-oracle-succeeded'`. Our `ctx.jitCost` at the
     * throw point — partial cost accumulated up to the error.
     */
    ourEvaluateCost?: number | null;
    /**
     * Hex excerpts of the relevant wire bytes for offline reproduction.
     * The harness intentionally does NOT embed the full BlockBundle — that
     * can be several MB; we keep just enough to reproduce the failure.
     */
    bundleExcerpt: {
        headerHex?: string;
        txHex?: string;
        spentBoxHex?: string;
    };
}

/**
 * Write an error report to `path`. Overwrites unconditionally — only one
 * report exists at any time (we halt on the first failure), so there's no
 * append-or-merge logic to worry about.
 *
 * Uses the same write-tmp-then-rename atomicity pattern as `checkpoint.ts`
 * so a crash mid-write cannot leave a half-written report on disk.
 */
export function writeErrorReport(path: string, r: ErrorReport): void {
    const tmp = `${path}.tmp`;
    const body = `${JSON.stringify(r, null, 2)}\n`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
}

/**
 * Remove the error report file. Idempotent: silently succeeds if the file
 * was already absent (ENOENT). Called on the first successful block after
 * a prior halt to clear the sidecar.
 */
export function deleteErrorReport(path: string): void {
    try {
        unlinkSync(path);
    } catch (err) {
        if (isNodeErrnoException(err) && err.code === 'ENOENT') {
            return;
        }
        throw err;
    }
}

/** Narrow `unknown` to `NodeJS.ErrnoException` for `.code` access. */
function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
    return err instanceof Error && 'code' in err;
}
