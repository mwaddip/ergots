/**
 * Shared error class for the mainnet-validate harness validation passes.
 *
 * Every validation phase (header, output round-trip, evaluate, signature
 * verify) raises `HarnessError` on detected mismatch. The class carries the
 * phase + a stable code + optional location info — exactly what the T7
 * `error-report.ts` writer needs to populate `ErrorReport`. The T11 walk
 * loop catches `HarnessError`, builds an `ErrorReport`, and calls
 * `writeErrorReport` before halting.
 *
 * # Why a dedicated class (not a discriminated union)?
 *
 * The harness uses `throw` for failure dispatch, so `instanceof HarnessError`
 * in `catch` arms is the cleanest discrimination. A union of plain objects
 * would force every catch site to type-narrow on `error.kind`, which is
 * ergonomically worse and loses the JS-stack-trace tooling. A class also
 * lets validation primitives in T9 / T10 throw without a manual `kind`
 * string — `new HarnessError(...)` is the entire API surface.
 *
 * # Code namespace
 *
 * `code` is a free-form string. Per PLAN T8, valid codes for the header
 * phase are:
 *
 *   - 'byte-roundtrip-mismatch'      — serializeHeader(parseHeader(bytes)) !== bytes
 *   - 'autolykos-v2-verify-false'    — verifyAutolykosV2 returned false
 *   - 'v1-header-after-v2-activation' — version 1 header at height >= v2ActivationHeight
 *   - 'parent-link-mismatch'         — header.parentId !== state.lastHeader.id
 *
 * Subsequent tasks (T9-T10) extend this with phase-specific codes:
 *
 *   - 'byte-roundtrip-mismatch'        (output-roundtrip phase, T9)
 *     — serializeTree(parseTree(ergoTreeBytes)) !== ergoTreeBytes
 *   - 'tree-version-derivation-failed' (output-roundtrip phase, T9)
 *     — treeVersionFn threw / returned an out-of-range value
 *   - 'sbox-parse-failed'              (output-roundtrip phase, T9)
 *     — parseSValue(SBox, ...) threw / returned non-Box kind
 *   - 'tree-parse-failed'              (output-roundtrip phase, T9)
 *     — parseTree threw on extracted ergoTreeBytes
 *   - 'tree-serialize-failed'          (output-roundtrip phase, T9)
 *     — serializeTree threw on the parsed tree
 *   - 'evaluate-mismatch'              (evaluate phase, T10) — exact set TBD
 *   - 'verify-signature-failed'        (verify-signature phase, T10) — exact set TBD
 *
 * Phase 2j-a adds the cost-equivalence sub-step with two new phases:
 *
 *   - 'evaluate-cost'                  — both eval'd; cost-comparison sub-step
 *       codes:
 *         'cost-drift'    — oracle cost ≠ ours cost
 *         'cost-overflow' — oracle cost > Number.MAX_SAFE_INTEGER
 *   - 'evaluate-oracle-mismatch'       — eval success/failure disagreement
 *       codes:
 *         'ours-succeeded-oracle-errored' — our eval OK, oracle errored
 *         'ours-errored-oracle-succeeded' — our eval errored, oracle OK
 *
 * These phases carry structured payload via `HarnessErrorOptions`
 * (see below).
 *
 * The union is NOT typed at the class level because each phase's catch
 * site only needs to dispatch on `code` against its own known values; an
 * exhaustive union would couple T8 to all future tasks.
 */

import type {
    ErrorPhase,
    ErrorReport,
    EvaluateCostPayload,
} from './error-report.js';

/**
 * Optional structured payload for the phase-2j-a cost-equivalence phases
 * (`'evaluate-cost'` and `'evaluate-oracle-mismatch'`). Fields map 1:1 to
 * the corresponding top-level `ErrorReport` keys so the writer can forward
 * them without re-structuring.
 *
 *   - `evaluateCost`     — set when `code === 'cost-drift'`
 *   - `oracleError`      — set when `code === 'ours-succeeded-oracle-errored'`
 *   - `ourError`         — set when `code === 'ours-errored-oracle-succeeded'`
 *   - `ourEvaluateCost`  — set whenever we have a partial cost to report
 *                          (oracle-mismatch in either direction)
 */
export interface HarnessErrorOptions {
    evaluateCost?: EvaluateCostPayload;
    oracleError?: string | null;
    ourError?: string | null;
    ourEvaluateCost?: number | null;
}

/**
 * Thrown by any validation primitive when a check fails. The walk loop
 * (T11) catches this and converts it to an `ErrorReport` for the sidecar.
 */
export class HarnessError extends Error {
    /** See `HarnessErrorOptions`; only set for the cost-equivalence phases. */
    public readonly evaluateCost?: EvaluateCostPayload;
    /** See `HarnessErrorOptions`; only set for cost-equivalence phases. */
    public readonly oracleError?: string | null;
    /** See `HarnessErrorOptions`; only set for cost-equivalence phases. */
    public readonly ourError?: string | null;
    /** See `HarnessErrorOptions`; only set for cost-equivalence phases. */
    public readonly ourEvaluateCost?: number | null;

    constructor(
        /** Which validation phase emitted this error. */
        public readonly phase: ErrorPhase,
        /** Stable string code for programmatic dispatch + sidecar reporting. */
        public readonly code: string,
        message: string,
        /**
         * Where in the block the failure was detected. Optional because
         * the header phase has no tx/input/output context, whereas the
         * evaluate/verify-signature phases populate txIndex/inputIndex.
         */
        public readonly location?: Partial<ErrorReport['location']>,
        /**
         * Structured payload for phase-2j-a cost-equivalence errors. Other
         * phases leave this undefined.
         */
        options?: HarnessErrorOptions,
    ) {
        super(message);
        this.name = 'HarnessError';
        this.evaluateCost = options?.evaluateCost;
        this.oracleError = options?.oracleError;
        this.ourError = options?.ourError;
        this.ourEvaluateCost = options?.ourEvaluateCost;
    }
}
