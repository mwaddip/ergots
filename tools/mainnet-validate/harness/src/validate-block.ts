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
import {
    parseTree,
    serializeTree,
    parseSValue,
    type SValue,
} from '@ergots/ergoscript';

import type { BlockBundle } from './bundle-types.js';
import { HarnessError } from './errors.js';
import { validateTx } from './validate-tx.js';

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
 * Output round-trip validation pass (PLAN.md T9).
 *
 * For every output box across every transaction in the block:
 *   1. `parseSValue({tag:'SBox'}, treeVersion, reader)` against the canonical
 *      box bytes (the shim emits these via `ErgoBox::sigma_serialize`).
 *   2. Extract `.ergoTreeBytes` from the parsed `ErgoBox`.
 *   3. `parseTree(ergoTreeBytes)` → `ErgoTree`.
 *   4. `serializeTree(tree)` must be byte-identical to the extracted bytes.
 *
 * On the first failure the function throws a `HarnessError` carrying
 * `phase: 'output-roundtrip'`, code = the specific structural reason, and
 * `location = { txIndex, outputIndex }`. The walk loop (T11) catches and
 * writes the error-report sidecar.
 *
 * # `treeVersionFn` injection
 *
 * `parseSValue` takes a `treeVersion` parameter (added in phase 2h-c.1 for
 * SHeader V3-gating; threads through every nested SValue parser, including
 * SBox register-value parsing). For an output box, the relevant tree-version
 * is the box's *own* ErgoTree's version (bits 0..2 of its header byte).
 *
 * The PLAN signature accepts a function rather than inlining the lookup so
 * that callers can swap the strategy: T11's `main.ts` passes a function
 * that locates the ErgoTree section within the canonical box bytes and
 * reads its header byte. The function is invoked once per output box.
 *
 * The function MUST be deterministic and side-effect-free; it MUST return a
 * value in `0..7`. If it throws, `validateOutputRoundtrips` wraps the error
 * as a `HarnessError` with code `'tree-version-derivation-failed'`.
 *
 * Halt-on-first-failure: the loop exits on the first byte-roundtrip
 * mismatch. No state mutation occurs in this pass — output round-trip is
 * a pure validation of the bundle's wire shape.
 */
export function validateOutputRoundtrips(
    bundle: BlockBundle,
    treeVersionFn: (boxBytes: Uint8Array) => number,
): void {
    for (let txIndex = 0; txIndex < bundle.transactions.length; txIndex++) {
        const tx = bundle.transactions[txIndex]!;
        for (let outputIndex = 0; outputIndex < tx.outputs.length; outputIndex++) {
            const boxBytes = tx.outputs[outputIndex]!;

            // Step 1a: derive treeVersion via the injected function.
            // Per Rule #5, we surface a tree-version-derivation failure as a
            // distinct code so the operator can tell it apart from a real
            // wire-shape mismatch (the function being wrong is a harness-side
            // bug; the bytes being wrong is a shim/chain disagreement).
            let treeVersion: number;
            try {
                treeVersion = treeVersionFn(boxBytes);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new HarnessError(
                    'output-roundtrip',
                    'tree-version-derivation-failed',
                    `treeVersionFn threw at tx ${txIndex}, output ${outputIndex}: ${message}`,
                    { txIndex, outputIndex },
                );
            }
            if (
                !Number.isInteger(treeVersion) ||
                treeVersion < 0 ||
                treeVersion > 7
            ) {
                throw new HarnessError(
                    'output-roundtrip',
                    'tree-version-derivation-failed',
                    `treeVersionFn returned out-of-range value ${String(treeVersion)} at tx ${txIndex}, output ${outputIndex} (expected 0..7)`,
                    { txIndex, outputIndex },
                );
            }

            // Step 1b: parse the canonical box bytes as SValue(SBox, ...).
            // parseSValue throws SValueParseError on malformed input; surface
            // as a harness error tagged with the failure code so the report
            // distinguishes structural from byte-equality failures.
            //
            // Per `facts/ergoscript-wire.md`, parseSValue does NOT enforce
            // `isExhausted` — trailing-byte checks are the caller's
            // responsibility. The shim's wire contract is that each output's
            // `boxBytes` is exactly one `ErgoBox::sigma_serialize` payload;
            // trailing bytes indicate corruption, so we explicitly check.
            let sbox: SValue;
            const reader = new ByteReader(boxBytes);
            try {
                sbox = parseSValue({ tag: 'SBox' }, treeVersion, reader);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new HarnessError(
                    'output-roundtrip',
                    'sbox-parse-failed',
                    `parseSValue(SBox) failed at tx ${txIndex}, output ${outputIndex}: ${message}`,
                    { txIndex, outputIndex },
                );
            }
            if (!reader.isExhausted) {
                throw new HarnessError(
                    'output-roundtrip',
                    'sbox-parse-failed',
                    `${reader.remaining} trailing bytes after SBox at tx ${txIndex}, output ${outputIndex}`,
                    { txIndex, outputIndex },
                );
            }

            // Defensive: parseSValue returned the wrong SValue variant. The
            // SType-driven dispatcher should never produce a non-Box result
            // for a `{tag:'SBox'}` request, but a future refactor could
            // silently break this invariant — pin it with an explicit check.
            if (sbox.kind !== 'Box') {
                throw new HarnessError(
                    'output-roundtrip',
                    'sbox-parse-failed',
                    `parseSValue(SBox) returned unexpected SValue.kind=${sbox.kind} at tx ${txIndex}, output ${outputIndex}`,
                    { txIndex, outputIndex },
                );
            }

            // Step 2: extract the box's internal ErgoTree bytes.
            const ergoTreeBytes = sbox.value.ergoTreeBytes;

            // Step 3: parse the ErgoTree. Failures here indicate either a
            // malformed tree on-chain (shouldn't happen — the node accepted
            // it) or a parser bug; either way it's worth surfacing.
            let tree;
            try {
                tree = parseTree(ergoTreeBytes);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new HarnessError(
                    'output-roundtrip',
                    'tree-parse-failed',
                    `parseTree failed at tx ${txIndex}, output ${outputIndex}: ${message}`,
                    { txIndex, outputIndex },
                );
            }

            // Step 4: serialize and byte-compare. The headline check — any
            // disagreement here is a real validation finding (parser drops
            // info, serializer reorders, version-gating mishandles a flag).
            let reSerialized: Uint8Array;
            try {
                reSerialized = serializeTree(tree);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new HarnessError(
                    'output-roundtrip',
                    'tree-serialize-failed',
                    `serializeTree failed at tx ${txIndex}, output ${outputIndex}: ${message}`,
                    { txIndex, outputIndex },
                );
            }
            if (!bytesEqual(reSerialized, ergoTreeBytes)) {
                throw new HarnessError(
                    'output-roundtrip',
                    'byte-roundtrip-mismatch',
                    `serializeTree(parseTree(ergoTreeBytes)) !== ergoTreeBytes at tx ${txIndex}, output ${outputIndex}`,
                    { txIndex, outputIndex },
                );
            }
        }
    }
}

/**
 * Per-block orchestrator (PLAN.md T10 Step 5): wires header + output
 * round-trip + per-tx evaluate/verifySignature passes in sequence.
 * Halt-on-first-failure: each phase throws `HarnessError` on detected
 * mismatch and the orchestrator propagates without catching.
 *
 * The order MUST be header → output → per-tx because the per-tx pass
 * reads `walkerState.rollingHeaders[0]` for the current PreHeader and
 * the header pass is what populates it.
 *
 * `treeVersionFn` is plumbed through to `validateOutputRoundtrips` per
 * T9's design — T11's `main.ts` injects a real derivation; tests
 * can inject a stub.
 */
export function validateBlock(
    bundle: BlockBundle,
    state: WalkerState,
    treeVersionFn: (boxBytes: Uint8Array) => number,
): void {
    validateHeader(bundle, state);
    validateOutputRoundtrips(bundle, treeVersionFn);
    for (let txIndex = 0; txIndex < bundle.transactions.length; txIndex++) {
        const tx = bundle.transactions[txIndex]!;
        validateTx(tx, bundle, state, txIndex);
    }
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
