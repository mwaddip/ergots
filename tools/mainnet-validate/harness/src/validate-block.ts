/**
 * Per-block validation passes for the mainnet-validate harness.
 *
 * This module owns the harness's block-level validation phases. T8 adds the
 * header pass; T9 will add the output round-trip pass; the per-tx evaluate
 * + signature-verify passes live in `validate-tx.ts` (T10).
 *
 * The walk loop in `main.ts` (T11) drives the pipeline: for each block it
 * calls `validateHeader(bundle, state)`, then `validateOutputRoundtrips(...)`
 * (T9), then per-tx `validateTransaction(...)` (T10). Each function throws
 * `HarnessError` on the first detected mismatch — halt-on-first-failure is
 * the harness's contract.
 *
 * # Why a `WalkerState` instead of bare globals?
 *
 * Three pieces of cross-block state need to survive between `validateHeader`
 * calls:
 *
 *   1. `lastHeader` — the previous block's header, for parent-link checks.
 *   2. `rollingHeaders` — the most recent 10 headers, consumed by T10's
 *      `evaluate` pass as `ctx.headers` (ErgoScript exposes `CONTEXT.headers`
 *      to scripts, capped at 10 by sigma-rust).
 *   3. `network` + `v2ActivationHeight` — config constants that affect V1
 *      acceptance semantics; carried in state so the harness can be re-used
 *      against testnet by callers (no rebuild needed).
 *
 * Bundling them in a mutable state struct lets the walk loop pass one object
 * to every validation function without threading multiple parameters or
 * exposing module-level mutable globals (which break test isolation).
 *
 * # Why throw vs return a Result?
 *
 * The harness halts on the first failure — no aggregation, no recovery. A
 * thrown `HarnessError` is the JS-idiomatic shape for this: the walk loop
 * catches once at the top, builds an `ErrorReport`, writes the sidecar,
 * exits non-zero. A `Result<void, HarnessError>` return would be heavier
 * with no benefit (every caller would `if (result.err) throw`).
 */

import type { Header } from '@ergots/scorex';
import {
    ByteReader,
    parseHeader,
    serializeHeader,
    verifyAutolykosV2,
    AutolykosV1NotSupportedError,
} from '@ergots/scorex';

import type { BlockBundle } from './protocol.js';
import { HarnessError } from './errors.js';

/**
 * Cross-block validation state. Mutated in-place by `validateHeader`.
 *
 * # Field semantics
 *
 *   - `lastHeader` is `null` only before the first block has validated;
 *     once any block has been processed it carries that block's parsed
 *     `Header` for the next call's parent-link check.
 *   - `rollingHeaders` is most-recent-first (index 0 = most recent), capped
 *     at 10 entries. Mirrors sigma-rust's `Context::headers` invariant; T10
 *     will pass this into `makeContext` for ergoscript evaluation.
 *   - `network` distinguishes mainnet from testnet — currently consumed
 *     only via `v2ActivationHeight`, but kept distinct so future tasks can
 *     dispatch network-specific config (e.g. NIP activation heights) on it
 *     without reshaping the state struct.
 *   - `v2ActivationHeight` is the block height at which the chain switches
 *     from Autolykos v1 to Autolykos v2. For mainnet it's 417792 (sourced
 *     from `@ergots/nipopow`'s `V2_ACTIVATION_HEIGHT_MAINNET` and matching
 *     sigma-rust's chain config). Carried in state — not hardcoded — so
 *     testnet runs can override it.
 */
export interface WalkerState {
    lastHeader: Header | null;
    rollingHeaders: Header[];
    network: 'mainnet' | 'testnet';
    v2ActivationHeight: number;
}

/**
 * Mainnet V2 activation height. Hard-coded here for harness convenience —
 * callers constructing a `WalkerState` for mainnet should set
 * `v2ActivationHeight: V2_ACTIVATION_HEIGHT_MAINNET`.
 *
 * Source: sigma-rust chain config — matched by `@ergots/nipopow`'s
 * `V2_ACTIVATION_HEIGHT_MAINNET`. Re-declared here (rather than imported
 * from nipopow) because the harness intentionally does not depend on
 * @ergots/nipopow.
 */
export const V2_ACTIVATION_HEIGHT_MAINNET = 417792;

/**
 * Header validation pass. Implements PLAN.md T8 in seven steps:
 *
 *   1. Parse the wire bytes into a `Header`.
 *   2. Assert `serializeHeader(parsed)` is byte-identical to the input
 *      bytes — protects against silent parse-then-mutate bugs that would
 *      otherwise pass step 4 (PoW verifies on `parsed`, not on the wire).
 *   3-4. PoW verification with V1-below-activation skip semantics:
 *        - V1 header at height < activation → catch `AutolykosV1NotSupportedError`,
 *          accept structurally (no PoW verify). Mirrors sigma-rust + the
 *          existing `@ergots/nipopow` verifier behavior.
 *        - V1 header at height >= activation → throw
 *          `v1-header-after-v2-activation`. A V1 header past V2 activation
 *          is consensus-invalid (it's the forged-prefix attack pattern
 *          patched by NIP-02; we treat it as a hard failure here).
 *        - V2+ header → `verifyAutolykosV2` must return true.
 *   5. Parent-link: header.parentId must equal state.lastHeader.id. Skipped
 *      at the first block (state.lastHeader === null) — the harness may
 *      resume at any height, so we cannot precondition on parent state.
 *   6. Prepend the validated header to the 10-deep rolling window.
 *   7. Update lastHeader so the next call's parent-link check has context.
 *
 * On any failure, throws `HarnessError { phase: 'header', code, message }`.
 * The walk loop catches and writes the error-report sidecar.
 *
 * Mutates `state` in place on success. Does NOT mutate state on throw —
 * the rolling window and lastHeader updates are deferred to after the PoW
 * + parent-link checks complete, so a thrown error leaves state pointing
 * at the last-successful block.
 */
export function validateHeader(bundle: BlockBundle, state: WalkerState): void {
    // Step 1: parse the wire bytes
    let header: Header;
    try {
        header = parseHeader(new ByteReader(bundle.headerBytes));
    } catch (err) {
        // parseHeader throws ReaderError on malformed input; surface as a
        // header-phase harness error so the operator sees the structural
        // diagnosis rather than a bare ReaderError stack.
        const message = err instanceof Error ? err.message : String(err);
        throw new HarnessError(
            'header',
            'parse-failed',
            `parseHeader failed at height ${bundle.height}: ${message}`,
        );
    }

    // Step 2: byte-equal round-trip
    const reSerialized = serializeHeader(header);
    if (!bytesEqual(reSerialized, bundle.headerBytes)) {
        throw new HarnessError(
            'header',
            'byte-roundtrip-mismatch',
            `serializeHeader(parseHeader(bytes)) !== bytes at height ${bundle.height}`,
        );
    }

    // Steps 3-4: PoW verification with V1 activation gating
    if (header.version === 1) {
        if (header.height >= state.v2ActivationHeight) {
            // V1 past V2 activation: consensus-invalid (forged-prefix
            // pattern; matches @ergots/nipopow's `v1-header-after-v2-activation`).
            throw new HarnessError(
                'header',
                'v1-header-after-v2-activation',
                `version 1 header at height ${header.height} >= v2 activation height ${state.v2ActivationHeight}`,
            );
        }
        // V1 below activation: structurally accept; no PoW verification.
        // Calling verifyAutolykosV2 would throw AutolykosV1NotSupportedError;
        // we don't call it (preferred to catch-and-ignore so the throw never
        // shows up in the error stack of unrelated bugs).
    } else {
        // V2+ header: PoW must verify. Re-throw any unexpected throws from
        // the verifier as-is (they indicate a library bug, not a chain
        // validation failure) per Rule #5 (no band-aids).
        let ok: boolean;
        try {
            ok = verifyAutolykosV2(header);
        } catch (err) {
            if (err instanceof AutolykosV1NotSupportedError) {
                // Reaching here means verifyAutolykosV2 disagrees with our
                // version check above — defensive guard, should be unreachable.
                throw new HarnessError(
                    'header',
                    'autolykos-v1-not-supported',
                    `verifyAutolykosV2 unexpectedly threw AutolykosV1NotSupportedError on version=${header.version} header at height ${header.height}`,
                );
            }
            throw err;
        }
        if (!ok) {
            throw new HarnessError(
                'header',
                'autolykos-v2-verify-false',
                `verifyAutolykosV2 returned false at height ${header.height}`,
            );
        }
    }

    // Step 5: parent-link (skip at the first block in this run)
    if (state.lastHeader !== null) {
        if (!bytesEqual(header.parentId, state.lastHeader.id)) {
            throw new HarnessError(
                'header',
                'parent-link-mismatch',
                `header.parentId at height ${header.height} does not match previous block's id (height ${state.lastHeader.height})`,
            );
        }
    }

    // Steps 6-7: only mutate state after all checks pass. PLAN.md prescribes
    // an array re-assignment via `slice(0, 10)` rather than in-place truncation;
    // either is observably equivalent for the harness (the state struct is the
    // only ref), but we mirror the spec literally for clarity.
    state.rollingHeaders.unshift(header);
    state.rollingHeaders = state.rollingHeaders.slice(0, 10);
    state.lastHeader = header;
}

/**
 * Byte-by-byte Uint8Array equality. Used by header round-trip + parent-link
 * checks. Constant-time is NOT required here — all comparisons are over
 * public data with no secret-dependent timing surface.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}
