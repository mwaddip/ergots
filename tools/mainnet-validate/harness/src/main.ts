/**
 * Mainnet-validate harness entry point (PLAN-2j-rest.md T12).
 *
 * Orchestrates a per-block validation walk against an ergo-node REST
 * surface + an indexer REST surface, with a WASM cost-oracle for
 * cost-equivalence comparisons. Reuses the validation pipeline
 * (validateBlock + validate-tx) verbatim from the pre-REST architecture;
 * only the data-fetch path is replaced.
 *
 * Per-block flow:
 *   1. assembler.assemble(h, rollingHeadersJson) — composes a
 *      BlockBundle from node REST fragments + indexer-served box bytes
 *      + WASM cost-oracle results.
 *   2. validateBlock(bundle, walkerState, treeVersionFn) — runs the
 *      header / output-roundtrip / evaluate / verify-signature passes.
 *   3. Update + persist checkpoint; advance the rolling-headers window.
 *
 * The walk loop is straight-line — no retries, no skip-and-continue,
 * no per-block parallelism. Halt on the first failure.
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
 * # Rolling-headers JSON propagation
 *
 * The WASM oracle's `computeTxOracleCosts` takes
 * `rollingHeadersJson: string[]` — up to 10 newest-first preceding-
 * header JSON strings. The main loop maintains this rolling array as
 * the walk progresses, sourcing each new entry from
 * `currentBundle.headerJson` (populated by BundleAssembler from the
 * node's `/blocks/{id}.header` JSON).
 *
 * On resume from a mid-chain checkpoint, the rolling-headers-JSON array
 * starts empty. The first ~10 blocks of the walk have a shorter window
 * than ideal, but the WASM oracle pads the rolling collection with the
 * current header when short (matches the prior shim's defensive
 * pattern in `cost_oracle.rs:194-200`), so cost-oracle results remain
 * sound. After 10 blocks the window is full and accurate.
 *
 * # Why the walker-state rebuild fetches headers via node REST
 *
 * For resume from h > 1 we deserialise headers via NodeClient's
 * `/blocks/{id}/validation-fragments` endpoint, which returns the
 * canonical Scorex `headerBytes` (the same shape parsed by
 * `parseHeader`). We deliberately do NOT walk via getBlock — that
 * would re-fetch all the tx data we don't need for header
 * reconstruction.
 *
 * # Why we DON'T pad walker state with synthetic headers
 *
 * `validateTx` skips per-tx evaluation when `rollingHeaders.length <= 1`
 * (mirrors sigma-rust at height 1). For a resume mid-chain we always
 * have a full preceding window, so the skip branch is only relevant
 * to the genesis range (`startHeight ∈ {0, 1}` — extremely rare for
 * smoke tests, and the default startHeight is 2 per spec §2).
 */

import { parseCliArgs, USAGE, type CliArgs } from './cli.js';
import { NodeClient, NodeRestError } from './rest/node-client.js';
import { IndexerClient, IndexerRestError } from './rest/indexer-client.js';
import { WasmCostOracle, WasmCostOracleError } from './wasm-oracle.js';
import { BundleAssembler } from './bundle-assembler.js';
import type { BlockBundle } from './bundle-types.js';
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

/** Hex-decode helper for header-id strings returned by the node REST API. */
function hexDecode(s: string): Uint8Array {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

/**
 * Resume helper: fetch the 10 headers immediately preceding `startHeight`
 * and assemble a `WalkerState` ready for `validateBlock(startHeight)`.
 *
 * Behaviour:
 *   - If `startHeight <= 2`: return a fresh-empty `WalkerState`. The
 *     default startHeight is 2 per spec §2 (h=1 deferred), so this is
 *     the common fresh-run case. `validateHeader`'s parent-link check
 *     skips when `lastHeader === null`.
 *   - Otherwise: fetch headers from `max(2, startHeight - 10)` up to
 *     `startHeight - 1` via the node REST API. For each height, look
 *     up the canonical header id via `getHeaderIdsAtHeight`, then read
 *     the Scorex-encoded header bytes from
 *     `getValidationFragments(headerId).headerBytes`. The resulting
 *     list is reversed to most-recent-first (the walker-state
 *     convention).
 *
 * Throws if any node call fails; the caller (`main`) is responsible for
 * surfacing the failure to the operator. We deliberately do NOT write
 * an error-report here — resume failures are operational (wrong
 * --node-url, node not running) rather than chain-validation findings.
 */
export interface RebuildResult {
    state: WalkerState;
    /**
     * Newest-first bytes of the same up-to-10 preceding headers stored in
     * `state.rollingHeaders`. Used to seed the WASM oracle's
     * `rollingHeaderBytes` so its `ctx.headers` matches what our evaluator
     * sees via `walkerState.rollingHeaders`. Without this seeding (and
     * starting `rollingHeaderBytes = []`), the oracle's `compute_tx_oracle_costs`
     * pads with the current block header × 10, producing divergent
     * `Context.headers` and silent cost-drift on any script that reads
     * `CONTEXT.headers(i)` for `i >= 1`. Found at h=680,341 iter-12.
     */
    initialRollingHeaderBytes: Uint8Array[];
}

export async function rebuildWalkerState(
    node: NodeClient,
    startHeight: number,
    network: 'mainnet' | 'testnet',
): Promise<RebuildResult> {
    const v2ActivationHeight =
        network === 'mainnet'
            ? V2_ACTIVATION_HEIGHT_MAINNET
            : V2_ACTIVATION_HEIGHT_TESTNET;

    if (startHeight <= 2) {
        return {
            state: {
                lastHeader: null,
                rollingHeaders: [],
                network,
                v2ActivationHeight,
            },
            initialRollingHeaderBytes: [],
        };
    }

    const firstHeight = Math.max(2, startHeight - ROLLING_WINDOW_SIZE);
    const lastHeight = startHeight - 1;

    // Fetch oldest-first so we can simply reverse() at the end. Sequential
    // by necessity — keep-alive amortizes connection cost, and resume is
    // a one-time cost per harness invocation.
    const ascending: Header[] = [];
    const ascendingBytes: Uint8Array[] = [];
    for (let h = firstHeight; h <= lastHeight; h++) {
        const ids = await node.getHeaderIdsAtHeight(h);
        if (ids.length === 0) {
            throw new Error(`no header at height ${h} during walker-state rebuild`);
        }
        const headerId = ids[0]!;
        const fragments = await node.getValidationFragments(headerId);
        const headerBytes = hexDecode(fragments.headerBytes);
        const header = parseHeader(new ByteReader(headerBytes));
        ascending.push(header);
        ascendingBytes.push(headerBytes);
    }

    // WalkerState convention: rollingHeaders is most-recent-first
    // (index 0 = lastHeader). Reverse the ascending fetch order.
    const rollingHeaders = ascending.slice().reverse();
    const initialRollingHeaderBytes = ascendingBytes.slice().reverse();
    const lastHeader = rollingHeaders[0] ?? null;

    return {
        state: {
            lastHeader,
            rollingHeaders,
            network,
            v2ActivationHeight,
        },
        initialRollingHeaderBytes,
    };
}

/**
 * Build an `ErrorReport` from an exception caught around
 * `assembler.assemble` or `validateBlock`. Discriminates on instanceof
 * to produce the most informative `phase` + `errorCode` available.
 *
 * `bundle` may be `undefined` when the assembler call itself failed (no
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

    if (err instanceof NodeRestError) {
        const out: ErrorReport = {
            timestamp,
            height,
            phase: 'node-rest',
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

    if (err instanceof IndexerRestError) {
        const out: ErrorReport = {
            timestamp,
            height,
            phase: 'indexer-rest',
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

    if (err instanceof WasmCostOracleError) {
        const out: ErrorReport = {
            timestamp,
            height,
            phase: 'wasm-oracle',
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
    // unhandled assertion, etc.) is bucketed as `phase: 'node-rest'` by
    // elimination: assemble() drives all three of node REST + indexer
    // REST + WASM oracle, and a non-classed throw most likely surfaced
    // from one of those paths.
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
        phase: 'node-rest',
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
function createInitialCheckpoint(args: CliArgs, startHeight: number, tipHeight: number): Checkpoint {
    const now = new Date().toISOString();
    return {
        lastValidatedHeight: startHeight - 1,
        tipHeightAtStart: tipHeight,
        lastValidatedAt: now,
        nodeUrl: args.nodeUrl,
        indexerUrl: args.indexerUrl,
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

    // Instantiate the data-fetch clients + WASM oracle eagerly (per spec
    // §3.3 — pay the WASM init cost up front, not on the first block).
    const node = new NodeClient(args.nodeUrl);
    const indexer = new IndexerClient(args.indexerUrl);
    let oracle: WasmCostOracle;
    try {
        oracle = await WasmCostOracle.init();
    } catch (err) {
        process.stderr.write(
            `error initializing WASM oracle: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        await node.close();
        await indexer.close();
        return 1;
    }
    const assembler = new BundleAssembler(node, indexer, oracle);

    try {
        // Step 1: node tip query — also the implicit "did /info respond"
        // smoke check. A failure here is a setup bug (wrong URL, node
        // down), not a chain validation finding.
        const info = await node.getInfo();
        const tipHeight = info.fullHeight;

        // Step 2: load (or initialise) checkpoint.
        const existingCheckpoint = readCheckpoint(args.checkpointPath);

        // Step 3: resolve start/end heights.
        let startHeight: number;
        if (args.startHeight !== undefined) {
            startHeight = args.startHeight;
        } else if (existingCheckpoint !== null) {
            startHeight = existingCheckpoint.lastValidatedHeight + 1;
        } else {
            // Default startHeight is 2 per spec §2 (h=1 deferred to a
            // follow-up — genesis-block fetch requires special-case
            // handling in BundleAssembler that's out of scope for v1).
            startHeight = 2;
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
        const { state: walkerState, initialRollingHeaderBytes } =
            await rebuildWalkerState(node, startHeight, args.network);

        // Rolling-headers BYTES window for the WASM oracle. Seeded from
        // `initialRollingHeaderBytes` (the bytes of the same headers stored
        // in `walkerState.rollingHeaders`) so the oracle's `ctx.headers`
        // matches our evaluator's view. Pre-iter-12 this was initialized
        // empty; the oracle padded with the current block header × 10,
        // producing divergent `Context.headers` and a silent cost-drift
        // on any script reading `CONTEXT.headers(i)` for `i >= 1`. Bytes
        // (not JSON) because `BlockHeader::from_json` cannot parse
        // Autolykos v2+ headers (null `powSolutions.d`/`w`); the binary
        // path via `sigma_parse_bytes` handles every chain version.
        let rollingHeaderBytes: Uint8Array[] = initialRollingHeaderBytes.slice();

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

            // 7a: assemble bundle (node REST + indexer REST + WASM oracle).
            try {
                currentBundle = await assembler.assemble(h, rollingHeaderBytes);
            } catch (err) {
                const report = classifyError(err, h, undefined);
                writeErrorReport(args.errorReportPath, report);
                process.stderr.write(
                    `halt at height ${h} (REST/oracle): ${err instanceof Error ? err.message : String(err)}\n`,
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
                    `halt at height ${h} (validation): ${err instanceof Error ? err.message : String(err)}\n`,
                );
                process.stdout.write(
                    `[heartbeat] halt at h=${h} — phase=${report.phase} errorCode=${report.errorCode ?? '<none>'}\n`,
                );
                return 1;
            }

            // 7c: advance the rolling-headers-BYTES window for the next
            // block's WASM oracle call. Newest-first; cap at 10.
            rollingHeaderBytes.unshift(currentBundle.headerBytes);
            if (rollingHeaderBytes.length > ROLLING_WINDOW_SIZE) {
                rollingHeaderBytes = rollingHeaderBytes.slice(0, ROLLING_WINDOW_SIZE);
            }

            // 7d: update + persist checkpoint.
            updateCheckpointStats(checkpoint, currentBundle);
            writeCheckpoint(args.checkpointPath, checkpoint);

            // 7e: heartbeat cadence — per HB_BLOCK_CADENCE successful blocks.
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

            // 7f: 100k-block milestone heartbeat (orchestrator schedules full
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
        await node.close();
        await indexer.close();
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
