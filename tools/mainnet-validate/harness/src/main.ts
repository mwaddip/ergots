/**
 * Mainnet-validate harness entry point (PLAN.md T11).
 *
 * Spawns the shim, walks the chain from a resume height to a stop
 * height, runs `validateBlock` on every block, persists a checkpoint
 * after each success, writes a structured error report and exits 1 on
 * the first failure.
 *
 * The walk loop is straight-line per PLAN.md T11 — no retries, no
 * skip-and-continue, no per-block parallelism. The harness is a
 * differential validator (Layers 1-7 of PLAN.md): any failure is
 * load-bearing and the operator must triage before resuming.
 *
 * # On the `treeVersionFn` we inject into `validateBlock`
 *
 * Per `validate-block.ts` `# treeVersionFn injection` doc: each output
 * box's relevant `treeVersion` is the low 3 bits of the box's own
 * ErgoTree header byte. The ErgoTree section starts right after the
 * leading VLQ-encoded `value` field in the canonical box bytes. We
 * implement the derivation by skipping the leading VLQ then reading
 * one byte. Failures (truncated input, missing tree byte) are surfaced
 * to the operator via the wrapping `HarnessError` machinery in
 * `validateOutputRoundtrips`.
 *
 * # Why the walker-state rebuild fetches headers via `getBlock`
 *
 * The shim exposes `GET_BLOCK` (returns full BlockBundle including tx
 * data) but no `GET_HEADER`-only fast path. For resume of the rolling
 * 10-window we deserialise the full bundle and discard everything but
 * `headerBytes`. This is slow (~bundled txs of recent mainnet blocks
 * carry hundreds of KB each) but correct, and resume is a one-time
 * cost per harness invocation. A `GET_HEADER` shortcut is noted in
 * T14's README as a possible future optimisation.
 *
 * # Why we DON'T pad walker state with synthetic headers
 *
 * `validateTx` skips per-tx evaluation when `rollingHeaders.length <= 1`
 * (mirrors sigma-rust at height 1). For a resume mid-chain we always
 * have a full preceding window, so the skip branch is only relevant
 * to the genesis range (`startHeight ∈ {0, 1}` — extremely rare for
 * smoke tests).
 */

import { parseCliArgs, USAGE, type CliArgs } from './cli.js';
import {
    ShimClient,
    ShimError,
    type BlockBundle,
} from './protocol.js';
import {
    readCheckpoint,
    writeCheckpoint,
    currentLibraryVersions,
    type Checkpoint,
} from './checkpoint.js';
import {
    writeErrorReport,
    deleteErrorReport,
    type ErrorReport,
} from './error-report.js';
import { HarnessError } from './errors.js';
import {
    validateBlock,
    V2_ACTIVATION_HEIGHT_MAINNET,
    type WalkerState,
} from './validate-block.js';
import {
    ByteReader,
    parseHeader,
    type Header,
} from '@ergots/scorex';

/**
 * Testnet v2-activation height. Sourced from ergo-node-rust's
 * `prompts/chain-voting-and-nipopow.md` line 46:
 *
 *   `pub version2_activation_height: u32,  // mainnet 417792, testnet 0 (not applicable)`
 *
 * Testnet was launched with Autolykos v2 from genesis, so the activation
 * gate trivially passes for any non-zero height. Setting the constant to
 * 0 turns `validateHeader`'s "V1 header at >= v2ActivationHeight" check
 * into "any V1 header rejected on testnet", which matches the JVM/Rust
 * semantics for a chain that never had V1 in the first place.
 */
export const V2_ACTIVATION_HEIGHT_TESTNET = 0;

/**
 * The number of rolling-window headers `validateTx` expects (the
 * `[Header; 10]` sigma-rust shape). Used by `rebuildWalkerState` to
 * size the pre-fetch loop.
 */
const ROLLING_WINDOW_SIZE = 10;

/**
 * Derive the `treeVersion` for an output box by reading the low 3 bits
 * of the box's ErgoTree header byte. The ErgoTree section starts
 * immediately after the leading VLQ-encoded `value` field in canonical
 * `ErgoBox::sigma_serialize` output.
 *
 * On any read failure (truncated input), throws a regular `Error`; the
 * caller (`validateOutputRoundtrips`) wraps it as a `HarnessError` with
 * code `'tree-version-derivation-failed'`.
 */
function deriveTreeVersionFromBoxBytes(boxBytes: Uint8Array): number {
    const reader = new ByteReader(boxBytes);
    // Skip the value VLQ — we don't care about its decoded value, just
    // that the cursor lands on the ErgoTree header byte.
    reader.readVlqBigInt();
    const headerByte = reader.readU8();
    return headerByte & 0x07;
}

/**
 * Compare two `libraryVersions` records for exact equality. Used for the
 * resume-time version-mismatch warning (Open item #2: warn, don't fail).
 */
function versionsMatch(
    a: Checkpoint['libraryVersions'],
    b: Checkpoint['libraryVersions'],
): boolean {
    return (
        a.scorex === b.scorex &&
        a.nipopow === b.nipopow &&
        a.avltree === b.avltree &&
        a.ergoscript === b.ergoscript
    );
}

/**
 * Resume helper: fetch the 10 headers immediately preceding `startHeight`
 * and assemble a `WalkerState` ready for `validateBlock(startHeight)`.
 *
 * Behaviour:
 *   - If `startHeight <= 1`: return a fresh-empty `WalkerState`. There
 *     is no preceding history at the genesis edge; `validateHeader`'s
 *     parent-link check skips when `lastHeader === null` (PLAN T8 step
 *     5: "Skipped at the first block in this run").
 *   - Otherwise: fetch headers from `max(0, startHeight - 10)` up to
 *     `startHeight - 1` via `shim.getBlock`. Each bundle's
 *     `headerBytes` is parsed into a `Header`. The resulting list is
 *     reversed to most-recent-first (the walker-state convention).
 *
 * Throws if any shim call fails; the caller (`main`) is responsible for
 * surfacing the failure to the operator. We deliberately do NOT write
 * an error-report here — resume failures are operational (wrong
 * --store-path, shim binary missing, stale checkpoint) rather than
 * chain-validation findings.
 */
export async function rebuildWalkerState(
    shim: ShimClient,
    startHeight: number,
    network: 'mainnet' | 'testnet',
): Promise<WalkerState> {
    const v2ActivationHeight =
        network === 'mainnet'
            ? V2_ACTIVATION_HEIGHT_MAINNET
            : V2_ACTIVATION_HEIGHT_TESTNET;

    if (startHeight <= 1) {
        return {
            lastHeader: null,
            rollingHeaders: [],
            network,
            v2ActivationHeight,
        };
    }

    const firstHeight = Math.max(1, startHeight - ROLLING_WINDOW_SIZE);
    const lastHeight = startHeight - 1;

    // Fetch oldest-first so we can simply reverse() at the end. Sequential
    // by necessity — `ShimClient` rejects concurrent requests.
    //
    // Uses `getHeader` (not `getBlock`) so resume from a checkpoint with
    // `startHeight > 1` works even after the sidecar has advanced past
    // the requested heights — `GET_BLOCK` would refuse with `past-indexed`
    // for h <= sidecar.indexed_up_to_height. Added at PROTOCOL_VERSION 3
    // (phase 2j-b-resume); see
    // `docs/specs/2026-05-23-ergoscript-2j-b-resume-shim-fix-design.md`.
    const ascending: Header[] = [];
    for (let h = firstHeight; h <= lastHeight; h++) {
        const headerData = await shim.getHeader(h);
        const header = parseHeader(new ByteReader(headerData.headerBytes));
        ascending.push(header);
    }

    // WalkerState convention: rollingHeaders is most-recent-first
    // (index 0 = lastHeader). Reverse the ascending fetch order.
    const rollingHeaders = ascending.slice().reverse();
    const lastHeader = rollingHeaders[0] ?? null;

    return {
        lastHeader,
        rollingHeaders,
        network,
        v2ActivationHeight,
    };
}

/**
 * Build an `ErrorReport` from an exception caught around `shim.getBlock`
 * or `validateBlock`. Discriminates on instanceof to produce the most
 * informative `phase` + `errorCode` available.
 *
 * `bundle` may be `undefined` when the shim call itself failed (no
 * bundle to excerpt). In that case `bundleExcerpt` is left empty.
 */
export function classifyError(
    err: unknown,
    height: number,
    bundle: BlockBundle | undefined,
): ErrorReport {
    const timestamp = new Date().toISOString();
    const bundleExcerpt: ErrorReport['bundleExcerpt'] = {};
    if (bundle !== undefined) {
        bundleExcerpt.headerHex = bytesToHex(bundle.headerBytes);
    }

    if (err instanceof HarnessError) {
        const out: ErrorReport = {
            timestamp,
            height,
            phase: err.phase,
            errorClass: err.name,
            errorCode: err.code,
            message: err.message,
            location: err.location ?? {},
            bundleExcerpt,
        };
        if (err.stack !== undefined) {
            out.stack = err.stack;
        }
        // Phase 2j-a structured payload — flatten the HarnessError's
        // cost-equivalence fields into the top-level ErrorReport keys
        // per spec lines 146-177. Only `evaluate-cost` and
        // `evaluate-oracle-mismatch` halts populate these; everything
        // else leaves them `undefined`.
        if (err.evaluateCost !== undefined) {
            out.evaluateCost = err.evaluateCost;
        }
        if (err.oracleError !== undefined) {
            out.oracleError = err.oracleError;
        }
        if (err.ourError !== undefined) {
            out.ourError = err.ourError;
        }
        if (err.ourEvaluateCost !== undefined) {
            out.ourEvaluateCost = err.ourEvaluateCost;
        }
        return out;
    }

    if (err instanceof ShimError) {
        const out: ErrorReport = {
            timestamp,
            height,
            phase: 'shim',
            errorClass: err.name,
            errorCode: err.code,
            message: err.message,
            location: {},
            bundleExcerpt,
        };
        if (err.stack !== undefined) {
            out.stack = err.stack;
        }
        return out;
    }

    // Generic fallback — anything else (TypeError from re-key layer,
    // unhandled assertion, Node EAGAIN on stdin write, etc.) is bucketed
    // as `phase: 'shim'` since by elimination it surfaced from below the
    // validation layer.
    const errorClass = err instanceof Error ? err.constructor.name : 'Error';
    const message =
        err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : JSON.stringify(err);
    const out: ErrorReport = {
        timestamp,
        height,
        phase: 'shim',
        errorClass,
        message,
        location: {},
        bundleExcerpt,
    };
    if (err instanceof Error && err.stack !== undefined) {
        out.stack = err.stack;
    }
    return out;
}

/**
 * Update an in-flight checkpoint to reflect successful validation of
 * `bundle`. Mutates in place to keep the per-block hot path allocation-
 * free.
 *
 * `elapsedMs` is recomputed from the original `startedAt` so a
 * mid-run pause (operator hits Ctrl+C, fixes a flag, resumes) doesn't
 * double-count time across runs — each new run gets its own
 * `startedAt` via `createInitialCheckpoint`.
 */
export function updateCheckpointStats(
    checkpoint: Checkpoint,
    bundle: BlockBundle,
): void {
    checkpoint.stats.totalBlocks += 1;
    checkpoint.stats.totalTxs += bundle.transactions.length;
    let boxes = 0;
    let spends = 0;
    for (const tx of bundle.transactions) {
        boxes += tx.outputs.length;
        spends += tx.inputs.length;
    }
    checkpoint.stats.totalBoxesValidated += boxes;
    checkpoint.stats.totalSpendsValidated += spends;
    checkpoint.lastValidatedHeight = bundle.height;
    checkpoint.lastValidatedAt = new Date().toISOString();
    const startedAtMs = Date.parse(checkpoint.stats.startedAt);
    if (!Number.isNaN(startedAtMs)) {
        checkpoint.stats.elapsedMs = Date.now() - startedAtMs;
    }
}

/**
 * Build the initial in-memory checkpoint for a fresh run (no on-disk
 * checkpoint, OR an explicit `--start-height` override that we treat as
 * "fresh starting point" rather than "resume from checkpoint").
 *
 * `lastValidatedHeight` is set to `startHeight - 1` so the resume math
 * (`startHeight = checkpoint.lastValidatedHeight + 1`) round-trips
 * correctly on a subsequent invocation without `--start-height`.
 */
function createInitialCheckpoint(_args: CliArgs, startHeight: number, tipHeight: number): Checkpoint {
    const now = new Date().toISOString();
    return {
        lastValidatedHeight: startHeight - 1,
        tipHeightAtStart: tipHeight,
        lastValidatedAt: now,
        // TODO(2j-rest): replace with _args.nodeUrl / _args.indexerUrl once
        // cli.ts and main.ts are fully ported to the REST architecture.
        nodeUrl: 'shim://local',
        indexerUrl: 'shim://local',
        libraryVersions: currentLibraryVersions(),
        stats: {
            totalBlocks: 0,
            totalTxs: 0,
            totalBoxesValidated: 0,
            totalSpendsValidated: 0,
            startedAt: now,
            elapsedMs: 0,
        },
    };
}

/** Hex-encode a `Uint8Array` for `ErrorReport.bundleExcerpt.headerHex`. */
function bytesToHex(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i]!.toString(16).padStart(2, '0');
    }
    return s;
}

/** Async sleep helper. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main walk loop. Returns the process exit code; the entry point at
 * the bottom of this file calls `process.exit(code)` on the resolved
 * value.
 */
export async function main(argv: readonly string[]): Promise<number> {
    let args: CliArgs;
    try {
        args = parseCliArgs(argv);
    } catch (err) {
        process.stderr.write(
            `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.stderr.write(USAGE);
        return 2;
    }

    const shim = ShimClient.spawn(args.shimPath, args.storePath, args.sidecarPath, args.network);
    try {
        // Step 1: shim tip query — also the implicit "did the shim start up
        // and accept its argv" smoke check. A failure here is a setup bug,
        // not a chain validation finding.
        const tipHeight = await shim.getTipHeight();

        // Step 2: load (or initialise) checkpoint.
        const existingCheckpoint = readCheckpoint(args.checkpointPath);

        // Step 3: resolve start/end heights.
        let startHeight: number;
        if (args.startHeight !== undefined) {
            startHeight = args.startHeight;
        } else if (existingCheckpoint !== null) {
            startHeight = existingCheckpoint.lastValidatedHeight + 1;
        } else {
            startHeight = 1;
        }
        const requestedEnd = args.maxHeight ?? tipHeight;
        const endHeight = Math.min(requestedEnd, tipHeight);

        if (startHeight > endHeight) {
            // Nothing to do — already validated past the requested end (or
            // tip), or the operator supplied a degenerate range.
            process.stdout.write(
                `Nothing to do: startHeight=${startHeight} > endHeight=${endHeight} (tip=${tipHeight})\n`,
            );
            return 0;
        }

        // Step 4: library-version mismatch warning (Open item #2 spec
        // default: warn-and-continue). Only relevant when there IS an
        // existing checkpoint.
        if (existingCheckpoint !== null) {
            const current = currentLibraryVersions();
            if (!versionsMatch(existingCheckpoint.libraryVersions, current)) {
                process.stderr.write(
                    'warning: library versions changed since last checkpoint; continuing anyway.\n',
                );
            }
        }

        // Step 5: choose the in-memory checkpoint. If there's an existing
        // one AND we're not overriding the start height, reuse it (so
        // stats accumulate across runs). Otherwise start fresh.
        const checkpoint: Checkpoint =
            existingCheckpoint !== null && args.startHeight === undefined
                ? existingCheckpoint
                : createInitialCheckpoint(args, startHeight, tipHeight);

        // Step 6: rebuild the rolling-window walker state.
        const walkerState = await rebuildWalkerState(shim, startHeight, args.network);

        process.stdout.write(
            `Walking ${startHeight}..${endHeight} (tip=${tipHeight}, network=${args.network})\n`,
        );
        // Heartbeat startup line — load-bearing for the 2j-b orchestrator's
        // tip-reach disambiguation: the `tip=` value here is what the loop
        // compares `checkpoint.lastValidatedHeight` against on harness exit 0.
        process.stdout.write(
            `[heartbeat] starting at h=${startHeight} (tip=${tipHeight})\n`,
        );

        // Step 7: per-block walk.
        let currentBundle: BlockBundle | undefined;
        // Heartbeat-tracking state (per main() invocation, not module-level).
        let hbLastHeight = startHeight;
        let hbLastWallMs = Date.now();
        const HB_BLOCK_CADENCE = 100;
        const MILESTONE_INTERVAL = 100000;
        for (let h = startHeight; h <= endHeight; h++) {
            if (args.sleepMs > 0) {
                await sleep(args.sleepMs);
            }

            // 7a: fetch from shim.
            try {
                currentBundle = await shim.getBlock(h);
            } catch (err) {
                const report = classifyError(err, h, undefined);
                writeErrorReport(args.errorReportPath, report);
                process.stderr.write(
                    `halt at height ${h} (shim fetch failed): ${err instanceof Error ? err.message : String(err)}\n`,
                );
                process.stdout.write(
                    `[heartbeat] halt at h=${h} — phase=${report.phase} errorCode=${report.errorCode ?? '<none>'}\n`,
                );
                return 1;
            }

            // 7b: validate.
            try {
                validateBlock(currentBundle, walkerState, deriveTreeVersionFromBoxBytes);
            } catch (err) {
                const report = classifyError(err, h, currentBundle);
                writeErrorReport(args.errorReportPath, report);
                process.stderr.write(
                    `halt at height ${h} (validation failed): ${err instanceof Error ? err.message : String(err)}\n`,
                );
                process.stdout.write(
                    `[heartbeat] halt at h=${h} — phase=${report.phase} errorCode=${report.errorCode ?? '<none>'}\n`,
                );
                return 1;
            }

            // 7c: update + persist checkpoint.
            updateCheckpointStats(checkpoint, currentBundle);
            writeCheckpoint(args.checkpointPath, checkpoint);

            // 7d: heartbeat cadence — per HB_BLOCK_CADENCE successful blocks.
            if (h - hbLastHeight >= HB_BLOCK_CADENCE) {
                const now = Date.now();
                const blockSpan = h - hbLastHeight;
                const avgMsPerBlk = Math.round((now - hbLastWallMs) / blockSpan);
                const epoch = Math.floor(h / 1024);
                process.stdout.write(
                    `[heartbeat] h=${h} (epoch ${epoch}) — txs=${checkpoint.stats.totalTxs} boxes=${checkpoint.stats.totalBoxesValidated} spends=${checkpoint.stats.totalSpendsValidated} — avg=${avgMsPerBlk}ms/blk\n`,
                );
                hbLastHeight = h;
                hbLastWallMs = now;
            }

            // 7e: 100k-block milestone heartbeat (orchestrator schedules full
            // rewalk after this). Fires exactly once per crossing.
            if (
                Math.floor(h / MILESTONE_INTERVAL) >
                Math.floor((h - 1) / MILESTONE_INTERVAL) &&
                h >= MILESTONE_INTERVAL
            ) {
                process.stdout.write(
                    `[heartbeat] crossed h=${h} milestone — orchestrator will schedule full rewalk next iteration\n`,
                );
            }
        }

        // Step 8: tip-reached bookkeeping.
        checkpoint.tipReachedAt = new Date().toISOString();
        writeCheckpoint(args.checkpointPath, checkpoint);
        // Clear any stale error-report from a prior failed run that this
        // successful walk has now superseded.
        deleteErrorReport(args.errorReportPath);
        process.stdout.write(`Tip reached at height ${endHeight}.\n`);
        process.stdout.write(`[heartbeat] tip reached at h=${endHeight}\n`);
        return 0;
    } catch (err) {
        // Anything that escaped the per-block try blocks: setup failures
        // (readCheckpoint, currentLibraryVersions, rebuildWalkerState).
        // No error-report (no specific height); surface to stderr.
        process.stderr.write(
            `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        if (err instanceof Error && err.stack !== undefined) {
            process.stderr.write(`${err.stack}\n`);
        }
        return 1;
    } finally {
        await shim.close();
    }
}

// Only run the main loop when executed as a CLI (not when imported by
// unit tests). The argv check is the standard ESM-friendly test for
// "is this the entry module" — see node docs:
// https://nodejs.org/api/modules.html#module_module_main_module
const isMainModule = process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
    main(process.argv.slice(2)).then(
        (code) => {
            process.exit(code);
        },
        (err: unknown) => {
            process.stderr.write(
                `unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
            );
            process.exit(1);
        },
    );
}
