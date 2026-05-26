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
    UnsignedTransaction,
    parameters_new,
    compute_tx_oracle_costs,
} from 'ergo-lib-wasm-nodejs';
import { parseLossless, stringifyLossless } from './rest/json-bigint.js';

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
     * Current block header as canonical scorex-serialized bytes (the
     * same wire representation the chain validator hashes). Pulled from
     * the node's `/blocks/{id}/validation-fragments` response. Replaces
     * the previous `headerJson` field because `BlockHeader::from_json`
     * cannot parse Autolykos v2+ headers (their `powSolutions.d`/`w`
     * fields are `null` and `DeserializeBigIntFrom` has no `Null`
     * variant) — surfaced at mainnet h=417,792.
     */
    headerBytes: Uint8Array;
    /**
     * Up to 10 newest-first preceding headers as canonical scorex bytes.
     * The WASM `BlockHeaders` collection requires exactly 10 entries; we
     * pad with the current header when short (matches the previous
     * defensive pattern; bytes-equivalent to the prior JSON-based path).
     */
    rollingHeaderBytes: Uint8Array[];
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
 * Parse a signed-transaction JSON into a sigma-rust `Transaction` without
 * triggering the tx_id round-trip check in `Transaction.from_json`. Mainnet
 * contains valid txs whose ErgoTrees don't byte-stably round-trip through
 * sigma-rust (e.g. header byte 0x10 — segregated constants with hasSize);
 * `from_json` rejects these with `InvalidTxId` even though the chain
 * validator accepted them.
 *
 * Strategy: split the signed JSON into an unsigned shape + per-input proofs,
 * parse via `UnsignedTransaction.from_json` (no tx_id field on
 * `UnsignedTransactionJson` per `chain/json/transaction.rs:30-42`, so no
 * check), then re-assemble via `Transaction.from_unsigned_tx(unsigned,
 * proofs)`.
 *
 * Iter-14 closure (h=693,479 tx 1). Source pinned by ergo-node-rust memory
 * `feedback_indexer_json_direct.md` which catalogued the same block as
 * triggering a sigma-rust crashloop on the JSON path.
 */
interface SignedInputJson {
    boxId: string;
    spendingProof: {
        proofBytes: string;
        extension: Record<string, string>;
    };
}

interface SignedTxJson {
    id?: string;
    inputs: SignedInputJson[];
    dataInputs: { boxId: string }[];
    outputs: unknown[];
    size?: number;
}

function parseTxBypassingIdCheck(txJson: string): Transaction {
    // CRITICAL: use parseLossless (BigInt-preserving) instead of JSON.parse.
    // Token amounts > 2^53 (e.g. 9223371996546264297 at mainnet h=693,479
    // tx 2 OUTPUTS[0]) lose precision through JS Number, producing wrong
    // amounts in the WASM oracle (off by hundreds). Discovered iter-15 via
    // ValDef sentinel trace showing sigma-rust computed v10=297 while we
    // computed v10=0; root cause was this JSON precision loss, not a
    // sigma-rust or evaluator bug. stringifyLossless on the rebuilt
    // unsigned JSON serialises BigInts back as JSON integer literals,
    // which sigma-rust's serde_json parses as i64 with full precision.
    const signed = parseLossless(txJson) as SignedTxJson;
    const proofs: Uint8Array[] = signed.inputs.map((inp) => {
        const hex = inp.spendingProof.proofBytes;
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    });
    const unsignedJson = {
        inputs: signed.inputs.map((inp) => ({
            boxId: inp.boxId,
            extension: inp.spendingProof.extension,
        })),
        dataInputs: signed.dataInputs,
        outputs: signed.outputs,
    };
    const unsigned = UnsignedTransaction.from_json(stringifyLossless(unsignedJson));
    try {
        return Transaction.from_unsigned_tx(unsigned, proofs);
    } finally {
        // `from_unsigned_tx` consumes the unsigned tx (the WASM wrapper
        // calls `__destroy_into_raw` on it). Calling .free() here would
        // double-free; the consumption is the cleanup.
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
     * compute_tx_oracle_costs (added by sigma-rust commit 643749b9; the
     * test-helper renames in 6c66bf2a only affected the `_test_only_*`
     * helpers, not this production function).
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
     *   - headerBytes: current header canonical scorex bytes (from /blocks/{id}/validation-fragments)
     *   - rollingHeaderBytes: up to 10 preceding headers (newest-first) as canonical scorex bytes
     *   - parameters: from /blocks/{id}/validation-fragments; null on extension parse fail
     *
     * Returns per-input results index-aligned with tx.inputs. oracleCost is
     * raw JitCost (NOT block cost). On per-input error (cost-limit exceeded,
     * etc.), oracleSucceeded=false with oracleError populated.
     */
    computeTxOracleCosts(args: ComputeTxOracleArgs): OracleInputResult[] {
        const owned: WasmFreeable[] = [];
        try {
            // Parse via UnsignedTransaction + from_unsigned_tx instead of
            // Transaction.from_json. Sigma-rust's signed-tx JSON deserializer
            // re-serializes the parsed inputs/outputs and rejects when the
            // recomputed tx_id != the JSON's tx_id. For some ErgoTrees
            // (e.g. header byte 0x10 — segregated constants with hasSize)
            // the parse+serialize cycle is NOT byte-stable, so a chain-valid
            // tx hits InvalidTxId. Mainnet h=693,479 tx 1 was crashlooping
            // ergo-node-rust until the indexer parsed JSON directly
            // (`[[reference-ergo-node-rust-memory-dir-cross-ref]]` —
            // `feedback_indexer_json_direct.md`). The unsigned path constructs
            // a `Transaction` via `from_unsigned_tx(unsigned, proofs)`, which
            // builds a TxId from the unsigned bytes plus proofs — no JSON
            // tx_id validation. UnsignedTransactionJson lacks the tx_id field
            // entirely (chain/json/transaction.rs:30-42), so there's no check
            // to fail.
            const tx = parseTxBypassingIdCheck(args.txJson);
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
            //
            // # Ownership note: PreHeader.from_block_header CONSUMES its arg
            //
            // `PreHeader.from_block_header(b)` calls `b.__destroy_into_raw()`
            // in the generated JS (see pkg-nodejs/ergo_lib_wasm.js line ~3682),
            // which sets `b.__wbg_ptr = 0`. This is a MOVE, not a borrow. After
            // the call, the JS BlockHeader object is unusable (null pointer).
            //
            // `new BlockHeaders(b)` and `blockHeaders.add(b)` do NOT consume —
            // they read `b.__wbg_ptr` without destroying it (Rust side calls
            // `b.clone()` internally). So the order here is:
            //   1. Parse ONE header for the rolling window (used by BlockHeaders)
            //   2. Build and pad the rolling window; construct BlockHeaders
            //   3. Parse a SECOND copy of the header for PreHeader (consumed)
            //
            // Parsing twice costs ~1 ms per block — negligible. The alternative
            // (clone via BlockHeaders.get(0)) creates a new Rust reference but
            // the returned BlockHeader is then also WASM-owned and must be freed,
            // making the ownership graph more complex. Double-parse is cleaner.

            // Step A: rolling window for BlockHeaders (not consumed, ptr stays valid)
            const rollingHeaders: BlockHeader[] = [];
            for (const hb of args.rollingHeaderBytes) {
                const h = BlockHeader.sigma_parse_bytes(hb);
                owned.push(h);
                rollingHeaders.push(h);
            }
            // Pad to 10 with fresh header instances (each needs its own ptr).
            while (rollingHeaders.length < 10) {
                const padHeader = BlockHeader.sigma_parse_bytes(args.headerBytes);
                owned.push(padHeader);
                rollingHeaders.push(padHeader);
            }

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

            // Step B: current header for PreHeader (consumed by from_block_header)
            const currentHeader = BlockHeader.sigma_parse_bytes(args.headerBytes);
            // Do NOT push currentHeader into owned — PreHeader.from_block_header
            // consumes it (destroys its internal WASM pointer via __destroy_into_raw).
            // Pushing a freed object into owned would cause a double-free in the
            // finally block. The Rust side allocates a new PreHeader from the
            // header's data, so no memory is leaked.
            const preHeader = PreHeader.from_block_header(currentHeader);
            owned.push(preHeader);

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

            // Map WASM results → TS plain objects. Push each result handle
            // into `owned[]` BEFORE the overflow check so the finally block
            // frees it even if a mid-loop throw aborts. (Without this, a
            // jit-cost-overflow at index i would leak handles for i+1..N-1.)
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
                owned.push(r);
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
            }
            return out;
        } catch (err) {
            if (err instanceof WasmCostOracleError) throw err;
            const message = err instanceof Error ? err.message : String(err);
            throw new WasmCostOracleError('wasm-call-threw', message);
        } finally {
            // Free every WASM-owned object to prevent leak. The try/catch
            // tolerates either wasm-bindgen's idempotent free pattern (JS
            // wrapper nulls the inner pointer on first call) OR a throw on
            // double-free if the binding doesn't implement the no-op path.
            // Behavior is safe either way; we don't depend on which.
            for (const o of owned) {
                try {
                    o.free();
                } catch {
                    /* idempotent or double-free; either way no recovery */
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
 * production constructor; for full field control we use `parameters_new`
 * (added by sigma-rust commit 643749b9 as a production gap-filler — NOT
 * feature-gated). Field order matches its signature (verified against
 * `cost_oracle.rs:327-348`):
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
 * benign for cost-oracle parity. A future cleanup could rename
 * `parameters_new` to fit a wider production Parameters builder
 * convention if the WASM bindings grow other tx-validation entry points.
 */
function buildParameters(maxBlockCost: number): Parameters {
    return parameters_new(
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
