/**
 * WASM cost-oracle wrapper. Hides ergo-lib-wasm-nodejs specifics.
 * Per spec §3.3 + §3.4: WASM is used ONLY for cost-oracle, not for any
 * @ergots/* validation channels.
 *
 * # Lifecycle
 *
 * - `init()` is called eagerly at harness startup (NOT lazy on first
 *   oracle call) so the ~100-500ms WASM init cost doesn't skew the first
 *   block's heartbeat avg-ms-per-blk.
 * - Every WASM object constructed inside `computeTxOracleCosts` is freed
 *   explicitly via .free() before return; prevents unbounded WASM memory
 *   growth across a 1M-block walk.
 *
 * # Header input shape (deviation from PLAN-2j-rest.md T2)
 *
 * The plan called for Scorex-serialized header bytes
 * (`BlockHeader::sigma_parse_bytes`). The WASM `BlockHeader` class only
 * exposes `from_json(json: string)` (verified against
 * `external/sigma-rust/bindings/ergo-lib-wasm/pkg-nodejs/ergo_lib_wasm.d.ts`
 * + `bindings/ergo-lib-wasm/src/block_header.rs`) — there is no
 * `sigma_parse_bytes`/`scorex_parse_bytes` binding for headers.
 *
 * Since the upstream Bundle Assembler (Task 7) already has the node's
 * `/blocks/{id}` JSON in hand, passing through the header-JSON string is
 * strictly cheaper than re-serializing to Scorex bytes just to re-parse
 * inside WASM. Adopted `headerJson`/`rollingHeadersJson: string[]` for
 * this reason; the spent-box / data-input bytes still flow as
 * `Uint8Array` because `ErgoBox.sigma_parse_bytes` DOES exist.
 */

import {
    BlockHeader,
    BlockHeaders,
    ErgoBox,
    ErgoBoxes,
    ErgoStateContext,
    Parameters,
    PreHeader,
    Transaction,
    _test_only_parameters_new,
    compute_tx_oracle_costs,
} from 'ergo-lib-wasm-nodejs';

export interface OracleInputResult {
    /** Raw JitCost = ctx.jit_cost_value(). NOT ReductionResult.cost. */
    oracleCost: bigint;
    oracleSucceeded: boolean;
    oracleError: string | null;
}

export interface ComputeTxOracleArgs {
    /** JSON.stringify(tx) for tx from node's /blocks/{id} JSON. */
    txJson: string;
    /** Per-input spent box bytes (canonical ErgoBox::sigma_serialize_bytes), index-aligned with tx.inputs. */
    spentBoxesBytes: Uint8Array[];
    /** Per-data-input box bytes, in tx order. */
    dataInputBoxesBytes: Uint8Array[];
    /**
     * Current block header as a JSON string (the same object the node
     * returns under `/blocks/{id}.header` or `/blocks/at/{h}.header`).
     */
    headerJson: string;
    /**
     * Up to 10 newest-first preceding headers as JSON strings. The
     * WASM `BlockHeaders` collection requires exactly 10 entries; we
     * pad with the current header when short (matches the shim's
     * `cost_oracle.rs:194-200` defensive pattern).
     */
    rollingHeadersJson: string[];
    /** Block parameters; null when extension parse failed (use sigma-rust default). */
    parameters: { maxBlockCost: number } | null;
}

export class WasmCostOracleError extends Error {
    constructor(
        public readonly code: 'wasm-not-loaded' | 'wasm-call-threw' | 'jit-cost-overflow',
        message: string,
    ) {
        super(message);
        this.name = 'WasmCostOracleError';
    }
}

/**
 * Tracked WASM objects must expose `.free()` per the wasm-bindgen
 * generated typings; using a narrow interface keeps the cleanup loop
 * typed end-to-end.
 */
interface WasmFreeable {
    free(): void;
}

export class WasmCostOracle {
    private constructor() {}

    /**
     * Initialize the WASM oracle. Idempotent. Verifies the binding exposes
     * compute_tx_oracle_costs (the function added by sigma-rust commit
     * 643749b9 / renamed in 6c66bf2a).
     */
    static async init(): Promise<WasmCostOracle> {
        if (typeof compute_tx_oracle_costs !== 'function') {
            throw new WasmCostOracleError(
                'wasm-not-loaded',
                'ergo-lib-wasm-nodejs did not expose compute_tx_oracle_costs; rebuild pkg-nodejs/ from external/sigma-rust + verify Task 1 binding addition',
            );
        }
        process.stderr.write('[wasm-oracle] loaded\n');
        return new WasmCostOracle();
    }

    /**
     * Compute per-input oracle costs for one transaction.
     *
     * Inputs:
     *   - txJson: JSON.stringify of the tx from /blocks/{id}'s blockTransactions.transactions[]
     *   - spentBoxesBytes: canonical ErgoBox::sigma_serialize bytes per input, index-aligned with tx.inputs
     *   - dataInputBoxesBytes: canonical bytes per data input
     *   - headerJson: current header JSON (as returned by the node REST API)
     *   - rollingHeadersJson: up to 10 preceding headers (newest-first) as JSON strings
     *   - parameters: from /blocks/{id}/validation-fragments; null on extension parse fail
     *
     * Returns per-input results index-aligned with tx.inputs. oracleCost is
     * raw JitCost (NOT block cost). On per-input error (cost-limit exceeded,
     * etc.), oracleSucceeded=false with oracleError populated.
     */
    computeTxOracleCosts(args: ComputeTxOracleArgs): OracleInputResult[] {
        const owned: WasmFreeable[] = [];
        try {
            const tx = Transaction.from_json(args.txJson);
            owned.push(tx);

            // Build the spent-boxes collection. `ErgoBoxes` has no
            // `from_array` constructor in the WASM API — it exposes
            // `new ErgoBoxes(first)` + `.add(rest)` and an `.empty()`
            // factory. Use the same pattern for data inputs.
            const spentBoxesColl = ergoBoxesFromBytesList(args.spentBoxesBytes, owned);
            owned.push(spentBoxesColl);
            const dataInputsColl = ergoBoxesFromBytesList(args.dataInputBoxesBytes, owned);
            owned.push(dataInputsColl);

            // Build state context.
            const currentHeader = BlockHeader.from_json(args.headerJson);
            owned.push(currentHeader);
            const preHeader = PreHeader.from_block_header(currentHeader);
            owned.push(preHeader);

            // Build rolling window padded to 10 (matches sigma-rust's
            // [Header; 10] requirement; see `block_header.rs:125-139`).
            // Pad with current header when short — defensive; harness
            // only invokes oracle when walker state is full anyway, but
            // matches shim's cost_oracle.rs:194-200 pattern.
            const rollingHeaders: BlockHeader[] = [];
            for (const hj of args.rollingHeadersJson) {
                const h = BlockHeader.from_json(hj);
                owned.push(h);
                rollingHeaders.push(h);
            }
            while (rollingHeaders.length < 10) rollingHeaders.push(currentHeader);

            const firstHeader = rollingHeaders[0];
            if (firstHeader === undefined) {
                // Defensive: the while-loop above guarantees length >= 10,
                // so this is unreachable. Required by noUncheckedIndexedAccess.
                throw new WasmCostOracleError(
                    'wasm-call-threw',
                    'rollingHeaders unexpectedly empty after padding',
                );
            }
            const blockHeaders = new BlockHeaders(firstHeader);
            owned.push(blockHeaders);
            for (let i = 1; i < rollingHeaders.length; i++) {
                const h = rollingHeaders[i];
                if (h !== undefined) blockHeaders.add(h);
            }

            const parameters =
                args.parameters !== null
                    ? buildParameters(args.parameters.maxBlockCost)
                    : Parameters.default_parameters();
            owned.push(parameters);

            const stateCtx = new ErgoStateContext(preHeader, blockHeaders, parameters);
            owned.push(stateCtx);

            // Call the production cost-oracle binding.
            const wasmResults = compute_tx_oracle_costs(
                tx,
                spentBoxesColl,
                dataInputsColl,
                stateCtx,
            );

            // Map WASM results → TS plain objects (freeing as we go).
            const out: OracleInputResult[] = [];
            for (let i = 0; i < wasmResults.length; i++) {
                const r = wasmResults[i];
                if (r === undefined) {
                    // noUncheckedIndexedAccess defensive guard;
                    // `for-let-i < length` keeps this unreachable.
                    throw new WasmCostOracleError(
                        'wasm-call-threw',
                        `compute_tx_oracle_costs returned undefined at index ${i}`,
                    );
                }
                const cost = r.cost(); // bigint (u64)
                if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new WasmCostOracleError(
                        'jit-cost-overflow',
                        `oracleCost ${cost} > MAX_SAFE_INTEGER at input ${i}`,
                    );
                }
                out.push({
                    oracleCost: cost,
                    oracleSucceeded: r.is_ok(),
                    oracleError: r.error_msg() ?? null,
                });
                r.free();
            }
            return out;
        } catch (err) {
            if (err instanceof WasmCostOracleError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            throw new WasmCostOracleError('wasm-call-threw', message);
        } finally {
            // Free every WASM-owned object to prevent leak. wasm-bindgen
            // `.free()` is idempotent — calling on an already-freed
            // handle is a no-op (the JS wrapper nulls the inner pointer
            // on first call), so the try/catch below is belt-and-braces.
            for (const o of owned) {
                try {
                    o.free();
                } catch {
                    /* idempotent */
                }
            }
        }
    }
}

// --- Helpers ---

/**
 * Build an `ErgoBoxes` collection from a list of canonical
 * `ErgoBox::sigma_serialize_bytes` byte arrays. The WASM API has
 * `ErgoBoxes.empty()`, `new ErgoBoxes(box)`, and `.add(box)`, but no
 * batch `from_array` — so we use the empty-then-add pattern. The
 * intermediate `ErgoBox` instances are pushed into `ownedAccumulator`
 * so the caller's finally-block can free them.
 */
function ergoBoxesFromBytesList(
    bytesList: Uint8Array[],
    ownedAccumulator: WasmFreeable[],
): ErgoBoxes {
    const coll = ErgoBoxes.empty();
    for (const b of bytesList) {
        const eb = ErgoBox.sigma_parse_bytes(b);
        ownedAccumulator.push(eb);
        coll.add(eb);
    }
    return coll;
}

/**
 * Build a `Parameters` object with a custom `max_block_cost`. The WASM
 * `Parameters` class only exposes `default_parameters()` as a
 * production constructor; for full field control we use
 * `_test_only_parameters_new` (added by sigma-rust commit 643749b9 for
 * the cost-oracle smoke tests). Field order matches its signature
 * (verified against `cost_oracle.rs:327-348`):
 *   1. block_version       — kept at 1
 *   2. storage_fee_factor  — kept at default-ish 1
 *   3. min_value_per_byte  — 360 (mainnet default)
 *   4. max_block_size      — 524288 (mainnet default)
 *   5. max_block_cost      — caller-supplied
 *   6. token_access_cost   — 0 (unused by oracle)
 *   7. input_cost          — 0 (unused by oracle)
 *   8. data_input_cost     — 0 (unused by oracle)
 *   9. output_cost         — 0 (unused by oracle)
 *
 * NOTE (binding gap): only `max_block_cost` feeds the oracle's
 * `jit_cost_limit` derivation, so zeroing the per-component costs is
 * benign for cost-oracle parity. A proper production `Parameters`
 * builder that takes all 9 fields cleanly (without the `_test_only_`
 * prefix) is a follow-up — current design surface for this binding is
 * "fine for cost oracle, not for tx-validation."
 */
function buildParameters(maxBlockCost: number): Parameters {
    return _test_only_parameters_new(
        1, // block_version
        1, // storage_fee_factor
        360, // min_value_per_byte
        524288, // max_block_size
        maxBlockCost,
        0, // token_access_cost
        0, // input_cost
        0, // data_input_cost
        0, // output_cost
    );
}
