/**
 * Per-transaction validation pass (PLAN.md T10; cost-equivalence sub-step
 * added in phase 2j-a T7).
 *
 * For each tx input the harness:
 *   1. Parses the spent box bytes via `parseSValue({tag:'SBox'}, ...)`.
 *   2. Pulls the ErgoTree out of the parsed box and runs `parseTree`.
 *   3. Decodes the per-input `ContextExtension` Constant blobs into
 *      `{tpe, value}` map entries (each blob is `SType || SValue`).
 *   4. Builds an `EvalContext` carrying chain state (height, self-box,
 *      inputs/outputs/data-inputs, pre-header, headers, extension,
 *      jitCostLimit, treeVersion, constants).
 *   5. Invokes `evaluateWith(tree, ctx)` — we hold `ctx` so we can read
 *      `ctx.jitCost` post-eval. `evaluateWith` does NOT auto-default
 *      `ctx.constants` from `tree.constants`; the harness sets both
 *      `treeVersion` and `constants` explicitly when building `ctx`.
 *   6. Phase 2j-a cost-equivalence sub-step (tri-modal):
 *      - both succeeded + costs equal → continue
 *      - both succeeded + costs differ → halt `'evaluate-cost' / 'cost-drift'`
 *      - our OK + oracle err → halt `'evaluate-oracle-mismatch' /
 *        'ours-succeeded-oracle-errored'`
 *      - our err + oracle OK → halt `'evaluate-oracle-mismatch' /
 *        'ours-errored-oracle-succeeded'`
 *      - both err → existing `'evaluate'` phase wrapping (lenient err/err
 *        cross-comparison; tighter check is 2j-a carry-forward).
 *   7. The result must be a `SigmaProp`; non-SigmaProp result halts.
 *   8. Invokes `verifySignature(sigmaProp, signingMessage, signatureBytes)`;
 *      a `false` (or `VerifyError`) halts validation.
 *
 * On any failure it throws a `HarnessError` carrying `phase` + `code` +
 * `location.{txIndex, inputIndex, spentBoxId, ergoTreeHex}` so the T11 walk
 * loop can write a usable error-report sidecar.
 *
 * # CRITICAL: `ctx.headers` padding convention for blocks at H < 10
 *
 * Sigma-rust's `Context.headers` is a fixed-size `[Header; 10]` array
 * (`ergotree-ir/src/chain/context.rs:40`). Real-node block validation
 * (ergo-node-rust `validation/src/tx_validation.rs:35-46`) builds this
 * array by:
 *
 *   1. Taking up to 10 "preceding headers" (the 10 most-recent headers
 *      BEFORE the current block, newest-first).
 *   2. If fewer than 10 are available, padding by REPEATING THE OLDEST
 *      header (`headers.last().unwrap().clone()`) until length == 10.
 *
 * Critically, the JVM/Rust convention does NOT pad with zero-filled
 * headers or with synthesized genesis-replicas — the pad value is the
 * actual oldest available preceding header (a real, fully-formed Header
 * with valid PoW etc.). This matters: ergoscript can call
 * `CONTEXT.headers(i).checkPow()` and a fake zero-padded Header would
 * make that throw mid-eval where Rust would not.
 *
 * Also from the Rust reference: when there are ZERO preceding headers
 * (only possible at height == 1 since genesis sits at height 0), Rust
 * SKIPS transaction validation entirely (`tx_validation.rs:104-108`
 * returns Ok(()) with a warning). We mirror that — heights with no
 * preceding header pass through without per-tx evaluation. Resumes from
 * height >= 2 always have at least one preceding header (the parent).
 *
 * # `preHeader` derivation
 *
 * The current block's `PreHeader` is field-projected from THIS block's
 * parsed header (`PreHeader::from(header)` at
 * `ergo-chain-types/src/preheader.rs:26-38`). The fields mirror exactly:
 * `{ version, parentId, timestamp, nBits, height, minerPk, votes }`
 * with `minerPk = header.autolykosSolution.minerPk`. `timestamp` in TS
 * Header is `bigint` (u64, lossless since F2); the TS `PreHeader.timestamp`
 * is also `bigint`, so the conversion at the boundary is an identity.
 *
 * # `rollingHeaders` semantics
 *
 * `WalkerState.rollingHeaders` (from T8) is most-recent-first and
 * already INCLUDES the just-validated current block's header at index
 * 0. So `preceding_headers = rollingHeaders.slice(1)` — drop the current
 * block, keep up to 9 truly-preceding ones, then pad with the oldest
 * available to reach length 10.
 *
 * # ContextExtension parsing
 *
 * Each `(varId, valueBytes)` entry's `valueBytes` is the shim's
 * `Constant::sigma_serialize` output = `SType || SValue` (no length
 * prefix). We mirror sigma-rust's
 * `Constant::sigma_parse`: read SType, then read SValue with that type
 * + the box-derived treeVersion.
 *
 * # `treeVersion` per input
 *
 * Each spent box carries its OWN ergoTree, and the relevant treeVersion
 * for parsing its registers (SHeader register edge-case) and for
 * SValue-decoding the corresponding ContextExtension Constants is the
 * SPENT BOX's own ergoTree-version (`ergoTreeBytes[0] & 0x07`). We
 * derive it inline per-input from the first byte of the parsed box's
 * `ergoTreeBytes`.
 *
 * # `jitCostLimit`
 *
 * Read from `block.parameters.maxBlockCost`. When the shim's extension
 * parser failed (Rust downgrades to `None`, which appears as
 * `parameters === null` in TS), we fall back to sigma-rust's
 * `Parameters::default().max_block_cost() == 1_000_000` (Rust
 * `chain/parameters.rs:166`). This matches the JVM/sigma-rust signing
 * path which uses `Parameters::default()` when no on-chain params are
 * available, and is conservative for validation: real on-chain
 * mainnet `MaxBlockCost` is ≥ 1_000_000.
 *
 * Source mapping summary:
 *   ergo-node-rust/validation/src/tx_validation.rs:35-60   (build_state_context)
 *   external/sigma-rust/ergotree-ir/src/chain/context.rs:25-55 (Context struct)
 *   external/sigma-rust/ergo-chain-types/src/preheader.rs:26-38 (PreHeader::from)
 *   external/sigma-rust/ergo-lib/src/chain/parameters.rs:154-170 (default MaxBlockCost)
 *   external/sigma-rust/ergo-lib/src/wallet/signing.rs:104-118 (Context build)
 */

import type { Header } from '@ergots/scorex';
import { ByteReader } from '@ergots/scorex';
import { ByteWriter } from '@ergots/scorex';
import {
    parseSValue,
    parseSType,
    parseTree,
    serializeSType,
    serializeSValue,
    evaluateWith,
    makeContext,
    verifySignature,
    EvalError,
    VerifyError,
} from '@ergots/ergoscript';
import type {
    ErgoBox,
    PreHeader,
    ContextExtension,
    SType,
    SValue,
} from '@ergots/ergoscript';

import type { BlockBundle, TxBundle, InputBundle } from './bundle-types.js';
import { HarnessError } from './errors.js';
import type { WalkerState } from './validate-block.js';

/**
 * Sigma-rust default `MaxBlockCost` from
 * `ergo-lib/src/chain/parameters.rs:166`. Used when the shim's
 * `BlockBundle.parameters` is `null` (the Rust extension parser
 * downgrades `Option<BlockParameters>` to `None` on parse failure;
 * we mirror sigma-rust's signing-path default).
 */
const DEFAULT_MAX_BLOCK_COST = 1_000_000;

/**
 * JIT cost ÷ block cost. sigma-rust `ergotree-interpreter/src/eval/costs.rs`
 * `JitCost`: "Values are in 10x scale relative to block costs. To convert to
 * block cost: divide by 10." `maxBlockCost` is a block-cost parameter, so the
 * raw-JIT cost limit the evaluator (and sigma-rust) enforce is
 * `maxBlockCost × 10`. Verified empirically (iter-27): the oracle on default
 * params (maxBlockCost 1,000,000) threw `CostLimitExceeded(10000000)`.
 */
const JIT_COST_PER_BLOCK_COST = 10;

// --- Storage rent (expired-box / demurrage) ------------------------------
// Ergo lets ANYONE spend a box older than STORAGE_PERIOD without satisfying
// its guarding script (empty proof), paying a storage fee and naming the
// fee/recreation output via context-extension var 127. Consensus runs this
// FIRST (sigma-rust ergo-lib/src/chain/transaction/storage_rent.rs +
// transaction.rs `verify_tx_input_proof`); on success the input is valid with
// cost 0 and NO script evaluation or signature verification at all.
//
// Iter-23 (mainnet h=1,051,232): the first storage-rent collection in mainnet
// history — genesis-era boxes (creationHeight 0) become rent-eligible at
// exactly h=1,051,200, and miners sweep expired dust en masse from here on.
// This is the general rule, not a per-box skip.
const STORAGE_PERIOD = 1_051_200;
const STORAGE_EXTENSION_INDEX = 127; // i8::MAX
/** sigma-rust ergo-lib/src/chain/parameters.rs default StorageFeeFactor. */
const DEFAULT_STORAGE_FEE_FACTOR = 1_250_000;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Canonical serialized bytes of one R4..R9 register entry (for the
 *  storage-rent register-preservation check). */
function registerEntryBytes(
    entry: { tpe: SType; value: SValue; opaqueBytes?: Uint8Array } | undefined,
    treeVersion: number,
): Uint8Array | null {
    if (entry === undefined) return null;
    if (entry.opaqueBytes !== undefined) return entry.opaqueBytes;
    const w = new ByteWriter();
    serializeSType(entry.tpe, w);
    serializeSValue(entry.tpe, entry.value, treeVersion, w);
    return w.toBytes();
}

/** Serialized byte length of a box == its canonical on-wire length
 *  (parse↔serialize is byte-identical for every box the harness handles). */
function serializedBoxLen(box: ErgoBox, treeVersion: number): number {
    const w = new ByteWriter();
    serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, treeVersion, w);
    return w.toBytes().length;
}

/**
 * Storage-rent spend check — mirrors sigma-rust
 * `storage_rent.rs::check_storage_rent_conditions`. The caller must have
 * already confirmed the spending proof is empty. Returns `true` iff the box is
 * validly spendable via storage rent (consensus then assigns cost 0 and skips
 * script evaluation + signature verification entirely).
 */
export function checkStorageRent(
    selfBox: ErgoBox,
    blockHeight: number,
    extension: ContextExtension,
    outputBoxes: readonly ErgoBox[],
    treeVersion: number,
    storageFeeFactor: number,
): boolean {
    if (blockHeight - selfBox.creationHeight < STORAGE_PERIOD) return false;
    const idxEntry = extension.values.get(STORAGE_EXTENSION_INDEX);
    if (idxEntry === undefined) return false;
    const idxVal = idxEntry.value;
    // sigma-rust `try_extract_into::<i16>()` — only an SShort extracts to i16.
    if (idxVal.kind !== 'Short') return false;
    const outputIdx = idxVal.value;
    if (outputIdx < 0 || outputIdx >= outputBoxes.length) return false;
    const out = outputBoxes[outputIdx]!;
    const storageFee =
        BigInt(serializedBoxLen(selfBox, treeVersion)) * BigInt(storageFeeFactor);
    // Dust: box value ≤ storage fee → spendable with no further restrictions.
    if (selfBox.value <= storageFee) return true;
    // Else the output at the named index must recreate the box: same creation
    // height as the spending block, value ≥ value−fee, and every register
    // except R0 (value) and R3 (creation info) preserved — i.e. R1 (ergoTree),
    // R2 (tokens), R4..R9 (additional registers).
    if (out.creationHeight !== blockHeight) return false;
    if (out.value < selfBox.value - storageFee) return false;
    if (!bytesEqual(selfBox.ergoTreeBytes, out.ergoTreeBytes)) return false;
    if (selfBox.tokens.length !== out.tokens.length) return false;
    for (let i = 0; i < selfBox.tokens.length; i++) {
        if (!bytesEqual(selfBox.tokens[i]!.id, out.tokens[i]!.id)) return false;
        if (selfBox.tokens[i]!.amount !== out.tokens[i]!.amount) return false;
    }
    for (let id = 4; id <= 9; id++) {
        const ab = registerEntryBytes(selfBox.registers[id], treeVersion);
        const bb = registerEntryBytes(out.registers[id], treeVersion);
        if (ab === null && bb === null) continue;
        if (ab === null || bb === null) return false;
        if (!bytesEqual(ab, bb)) return false;
    }
    return true;
}

/**
 * Field-project a parsed `Header` into a `PreHeader`. Mirrors
 * sigma-rust `impl From<Header> for PreHeader`
 * (`ergo-chain-types/src/preheader.rs:26-38`):
 *
 *   PreHeader {
 *     version, parent_id, timestamp, n_bits, height,
 *     miner_pk: bh.autolykos_solution.miner_pk,
 *     votes,
 *   }
 *
 * Note `timestamp` in TS `Header` is `bigint` (u64, lossless since F2);
 * the TS `PreHeader` is also typed `bigint` (matching Rust `u64`). The
 * `BigInt(h.timestamp)` call below is now an identity — kept for
 * clarity at the type boundary but incurs no precision loss.
 */
export function preHeaderFromHeader(h: Header): PreHeader {
    return {
        version: h.version,
        parentId: h.parentId,
        timestamp: BigInt(h.timestamp),
        nBits: h.nBits,
        height: h.height,
        minerPk: h.autolykosSolution.minerPk,
        votes: h.votes,
    };
}

/**
 * Build the 10-element `headers` array for `EvalContext.headers`,
 * matching sigma-rust's `[Header; 10]` shape via the
 * ergo-node-rust `build_headers_array` algorithm
 * (`validation/src/tx_validation.rs:35-46`):
 *
 *   1. Take up to 10 preceding headers (newest-first input).
 *   2. Pad with `headers.last()` (the oldest available) until length 10.
 *
 * Returns `null` when `preceding` is empty — this signals "skip per-tx
 * validation" (matching Rust's `preceding_headers.is_empty()` early
 * return at `tx_validation.rs:104-108`). The caller decides what to do
 * with the null (we skip evaluation since we cannot build a
 * sigma-rust-equivalent context).
 *
 * Preconditions: `preceding` is in newest-first order (matches our
 * `WalkerState.rollingHeaders` invariant).
 */
function buildHeadersArray(preceding: readonly Header[]): Header[] | null {
    if (preceding.length === 0) {
        return null;
    }
    // Take up to 10 newest-first. If exactly 10 we're done; otherwise pad.
    const headers: Header[] = preceding.slice(0, 10);
    const pad = headers[headers.length - 1]!; // oldest available (non-null since length >= 1)
    while (headers.length < 10) {
        headers.push(pad);
    }
    return headers;
}

/**
 * Parse one `ContextExtension` `(varId, valueBytes)` blob. Each blob
 * is `Constant::sigma_serialize` = `SType || SValue` (mirrors
 * sigma-rust `Constant::sigma_parse`). The reader MUST consume the
 * whole blob — trailing bytes indicate a wire-shape disagreement.
 *
 * Returns the `{tpe, value}` pair the harness drops into
 * `ContextExtension.values`. Throws a regular `Error` on failure;
 * the caller wraps as `HarnessError` with context.
 */
function parseContextExtensionEntry(
    valueBytes: Uint8Array,
    treeVersion: number,
): { tpe: SType; value: SValue } {
    const reader = new ByteReader(valueBytes);
    const tpe = parseSType(reader);
    const value = parseSValue(tpe, treeVersion, reader);
    if (!reader.isExhausted) {
        throw new Error(
            `${reader.remaining} trailing byte(s) after Constant; ` +
                `expected exhausted reader after parseSType + parseSValue`,
        );
    }
    return { tpe, value };
}

/**
 * Build the `ContextExtension` map for one input. Each entry is parsed
 * via `parseContextExtensionEntry`; failures throw `HarnessError` with
 * `phase: 'evaluate'` (parse failure is part of evaluation setup, not
 * a verifier outcome).
 */
function buildContextExtension(
    input: InputBundle,
    treeVersion: number,
    txIndex: number,
    inputIndex: number,
): ContextExtension {
    const values: ContextExtension['values'] = new Map();
    for (const entry of input.contextExtension) {
        try {
            values.set(entry.varId, parseContextExtensionEntry(
                entry.valueBytes,
                treeVersion,
            ));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new HarnessError(
                'evaluate',
                'context-extension-parse-failed',
                `ContextExtension entry varId=${entry.varId} at tx ${txIndex}, input ${inputIndex}: ${message}`,
                { txIndex, inputIndex },
            );
        }
    }
    return { values };
}

/**
 * Parse the spent-box bytes (canonical `ErgoBox::sigma_serialize`
 * output) into the `ErgoBox` runtime shape and return the box, the
 * ergoTreeBytes, and the derived treeVersion. Throws `HarnessError`
 * on any parse failure.
 *
 * `treeVersion` is read from `ergoTreeBytes[0] & 0x07` (the low 3
 * bits of the tree header byte — the "language version" field per
 * `wire/ergo-tree.ts:118` and the Rust `ErgoTreeHeader`).
 */
function parseSpentBox(
    spentBoxBytes: Uint8Array,
    txIndex: number,
    inputIndex: number,
): { box: ErgoBox; ergoTreeBytes: Uint8Array; treeVersion: number } {
    // Derive treeVersion from the BOX's ergoTree (must come from inside
    // the box, but SBox is `<value VLQ><ergoTree...>`). Sigma-rust's
    // SBox parser ignores treeVersion for primitive registers; the
    // treeVersion only matters for SHeader-typed register values. For
    // robustness we read it from the box's own ergoTree header byte
    // after a two-step parse — first parse with version 0 (safe default
    // for non-SHeader registers), then re-extract from the parsed
    // box's ergoTreeBytes if needed.
    //
    // Practical optimization: we parse once with treeVersion = 0 and
    // then read the real treeVersion off the resulting
    // `box.ergoTreeBytes[0] & 0x07`. If the box contains SHeader
    // registers gated on V3 semantics this could matter; in practice
    // no mainnet output box uses SHeader registers (T9 stub used 0
    // throughout and 39M-block validation has not encountered an
    // SHeader register). We pass 0 here; the post-parse treeVersion is
    // used downstream for ContextExtension Constant parsing and
    // `evaluate(tree, ...)` auto-derives its own.
    let parsed: SValue;
    const reader = new ByteReader(spentBoxBytes);
    try {
        parsed = parseSValue({ tag: 'SBox' }, 0, reader);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new HarnessError(
            'evaluate',
            'spent-box-parse-failed',
            `parseSValue(SBox) failed at tx ${txIndex}, input ${inputIndex}: ${message}`,
            { txIndex, inputIndex },
        );
    }
    if (!reader.isExhausted) {
        throw new HarnessError(
            'evaluate',
            'spent-box-parse-failed',
            `${reader.remaining} trailing byte(s) after SBox at tx ${txIndex}, input ${inputIndex}`,
            { txIndex, inputIndex },
        );
    }
    if (parsed.kind !== 'Box') {
        throw new HarnessError(
            'evaluate',
            'spent-box-parse-failed',
            `parseSValue(SBox) returned unexpected kind=${parsed.kind} at tx ${txIndex}, input ${inputIndex}`,
            { txIndex, inputIndex },
        );
    }
    const ergoTreeBytes = parsed.value.ergoTreeBytes;
    if (ergoTreeBytes.length === 0) {
        throw new HarnessError(
            'evaluate',
            'spent-box-parse-failed',
            `parseSValue(SBox) returned empty ergoTreeBytes at tx ${txIndex}, input ${inputIndex}`,
            { txIndex, inputIndex },
        );
    }
    const treeVersion = ergoTreeBytes[0]! & 0x07;
    return { box: parsed.value, ergoTreeBytes, treeVersion };
}

/**
 * Parse every box bundle (input / output / data-input) in a tx into
 * `ErgoBox` runtime values. Shared between `validateTx` setup and any
 * future caller that needs the same boxes. Throws `HarnessError` with
 * a precise location on first failure.
 *
 * Inputs use the box's own treeVersion derived per-box; outputs and
 * data-inputs are parsed with treeVersion=0 (same justification as
 * the T9 output round-trip pass: no SHeader registers in practice).
 */
function parseTxBoxes(tx: TxBundle, txIndex: number): {
    inputBoxes: ErgoBox[];
    inputTreeVersions: number[];
    inputErgoTreeBytes: Uint8Array[];
    outputBoxes: ErgoBox[];
    dataInputBoxes: ErgoBox[];
} {
    const inputBoxes: ErgoBox[] = [];
    const inputTreeVersions: number[] = [];
    const inputErgoTreeBytes: Uint8Array[] = [];
    for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i]!;
        const { box, ergoTreeBytes, treeVersion } = parseSpentBox(
            input.spentBoxBytes,
            txIndex,
            i,
        );
        inputBoxes.push(box);
        inputTreeVersions.push(treeVersion);
        inputErgoTreeBytes.push(ergoTreeBytes);
    }

    const outputBoxes: ErgoBox[] = [];
    for (let i = 0; i < tx.outputs.length; i++) {
        const reader = new ByteReader(tx.outputs[i]!);
        let parsed: SValue;
        try {
            parsed = parseSValue({ tag: 'SBox' }, 0, reader);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new HarnessError(
                'evaluate',
                'output-box-parse-failed',
                `parseSValue(SBox) failed at tx ${txIndex}, output ${i}: ${message}`,
                { txIndex, outputIndex: i },
            );
        }
        if (parsed.kind !== 'Box') {
            throw new HarnessError(
                'evaluate',
                'output-box-parse-failed',
                `parseSValue(SBox) returned unexpected kind=${parsed.kind} at tx ${txIndex}, output ${i}`,
                { txIndex, outputIndex: i },
            );
        }
        outputBoxes.push(parsed.value);
    }

    const dataInputBoxes: ErgoBox[] = [];
    for (let i = 0; i < tx.dataInputBoxes.length; i++) {
        const reader = new ByteReader(tx.dataInputBoxes[i]!);
        let parsed: SValue;
        try {
            parsed = parseSValue({ tag: 'SBox' }, 0, reader);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new HarnessError(
                'evaluate',
                'data-input-box-parse-failed',
                `parseSValue(SBox) failed at tx ${txIndex}, dataInput ${i}: ${message}`,
                { txIndex },
            );
        }
        if (parsed.kind !== 'Box') {
            throw new HarnessError(
                'evaluate',
                'data-input-box-parse-failed',
                `parseSValue(SBox) returned unexpected kind=${parsed.kind} at tx ${txIndex}, dataInput ${i}`,
                { txIndex },
            );
        }
        dataInputBoxes.push(parsed.value);
    }

    return {
        inputBoxes,
        inputTreeVersions,
        inputErgoTreeBytes,
        outputBoxes,
        dataInputBoxes,
    };
}

/**
 * Hex-encode a `Uint8Array` for inclusion in a `HarnessError.location`.
 * Pure helper — no allocation-aware tuning needed since error paths
 * are by definition rare.
 */
function bytesToHex(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
        s += bytes[i]!.toString(16).padStart(2, '0');
    }
    return s;
}

/**
 * Format a thrown value from our TS evaluator into a human-readable string
 * for the phase-2j-a `oracle-mismatch` payload's `ourError` field.
 *
 * `EvalError` gets the `EvalError[code]: message` form so the stable code
 * is visible alongside the human message — matters because the cost-diff
 * sub-step's mismatched-direction tests grep on `err.code`.
 */
function formatOurError(err: unknown): string {
    if (err instanceof EvalError) {
        return `EvalError[${err.code}]: ${err.message}`;
    }
    if (err instanceof Error) {
        return `${err.constructor.name}: ${err.message}`;
    }
    return String(err);
}

/**
 * Validate every input of one transaction. See module doc for the
 * full algorithm + the source-read citations.
 *
 * `txIndex` is passed in by the orchestrator (`validateBlock` in
 * `validate-block.ts`) so the harness can report
 * `location.txIndex` without re-computing it from the bundle.
 *
 * Returns `void` on success. Throws `HarnessError` with one of:
 *   - `'spent-box-parse-failed'`
 *   - `'output-box-parse-failed'`
 *   - `'data-input-box-parse-failed'`
 *   - `'tree-parse-failed'`
 *   - `'context-extension-parse-failed'`
 *   - `'evaluate-threw'` (any non-EvalError throw + both-error case)
 *   - `'evaluate-not-implemented'` (`EvalError.code === 'not-implemented-yet'`
 *      or any of the `'*-method-not-implemented'` codes; both-error case)
 *   - `'evaluate-eval-error'` (any other `EvalError`; both-error case)
 *   - `'cost-overflow'` (phase `'evaluate-cost'`; oracleCost exceeded
 *      `Number.MAX_SAFE_INTEGER`)
 *   - `'cost-drift'` (phase `'evaluate-cost'`; both eval'd, costs differ)
 *   - `'ours-errored-oracle-succeeded'` (phase `'evaluate-oracle-mismatch'`)
 *   - `'ours-succeeded-oracle-errored'` (phase `'evaluate-oracle-mismatch'`)
 *   - `'non-sigmaprop-result'`
 *   - `'verifier-threw'` (VerifyError from verifier setup / parse)
 *   - `'verifier-false'` (verifier returned `false`)
 */
export function validateTx(
    tx: TxBundle,
    block: BlockBundle,
    walkerState: WalkerState,
    txIndex: number,
): void {
    // Step 0 — without a current header we cannot build PreHeader; this
    // signals an upstream wiring bug (validateBlock must call
    // validateHeader first) and is worth surfacing explicitly rather
    // than dereferencing null further down.
    const currentHeader = walkerState.rollingHeaders[0];
    if (currentHeader === undefined) {
        throw new HarnessError(
            'evaluate',
            'walker-state-missing-header',
            `WalkerState.rollingHeaders is empty at tx ${txIndex}; ` +
                `validateBlock must call validateHeader before validateTx`,
            { txIndex },
        );
    }

    // Step 1 — build the 10-deep headers array from PRECEDING headers
    // (drop index 0 which is the just-validated current block). If no
    // preceding headers (height == 1 only), match sigma-rust by SKIPPING
    // per-tx evaluation entirely — Rust returns Ok(()) with a warning at
    // `tx_validation.rs:104-108`. Real harness runs from heights >= 2
    // will always have at least one preceding header.
    const preceding = walkerState.rollingHeaders.slice(1);
    const headers = buildHeadersArray(preceding);
    if (headers === null) {
        // Height 1 (or resume-without-history) — no preceding header,
        // sigma-rust skips. Mirror that.
        return;
    }

    // Step 2 — parse every box bundle (inputs / outputs / data-inputs).
    // A parse failure anywhere is a harness halt, not a per-input retry.
    const {
        inputBoxes,
        inputTreeVersions,
        inputErgoTreeBytes,
        outputBoxes,
        dataInputBoxes,
    } = parseTxBoxes(tx, txIndex);

    // Step 3 — derive PreHeader from current block's header.
    const preHeader = preHeaderFromHeader(currentHeader);

    // Step 4 — derive jitCostLimit. block.parameters.maxBlockCost is the
    // height-active value (bundle-assembler resolves it from the epoch boundary
    // for non-boundary blocks). It is in BLOCK-cost units; the evaluator's
    // raw-JIT limit is ×10 (sigma-rust JitCost is 10× block cost — iter-27).
    const maxBlockCost =
        block.parameters !== null
            ? block.parameters.maxBlockCost
            : DEFAULT_MAX_BLOCK_COST;
    const jitCostLimit = maxBlockCost * JIT_COST_PER_BLOCK_COST;

    // Step 5 — per-input loop: parse tree, build extension, evaluate,
    // verifySignature. First failure halts.
    for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
        const input = tx.inputs[inputIndex]!;
        const selfBox = inputBoxes[inputIndex]!;
        const ergoTreeBytes = inputErgoTreeBytes[inputIndex]!;
        const treeVersion = inputTreeVersions[inputIndex]!;
        // Per-input `location` payload reused by every halt site below.
        // Centralised so adding new location fields (e.g., `txId` in
        // phase 2j-a per spec §location) lands in one spot.
        const location = {
            txIndex,
            txId: bytesToHex(tx.txId),
            inputIndex,
            spentBoxId: bytesToHex(input.boxId),
            ergoTreeHex: bytesToHex(ergoTreeBytes),
        };

        // 5a — build ContextExtension from per-input Constant blobs. Built
        // BEFORE the storage-rent check + tree parse: it needs no parsed tree,
        // and the storage-rent check (5b-bis) consumes it.
        const extension = buildContextExtension(
            input,
            treeVersion,
            txIndex,
            inputIndex,
        );

        // 5b-bis — storage-rent (expired-box) spend. Tried FIRST, mirroring
        // sigma-rust `try_spend_storage_rent`: only when the spending proof is
        // empty, and on success the input is consensus-valid with cost 0 and
        // NO script eval, signature verification, or oracle cost comparison
        // (the oracle's reduce_to_crypto cost for such an input is a phantom
        // consensus never charges — so we `continue` past steps 5c–5h).
        // Non-empty proofs always fall through to the normal eval+verify path,
        // which still correctly handles `TrivialProp(true)` empty proofs.
        if (input.signatureBytes.length === 0) {
            // block.parameters carries only maxBlockCost (and is null for
            // historical blocks), so StorageFeeFactor uses the sigma-rust
            // default — same posture as DEFAULT_MAX_BLOCK_COST above.
            if (
                checkStorageRent(
                    selfBox,
                    block.height,
                    extension,
                    outputBoxes,
                    treeVersion,
                    DEFAULT_STORAGE_FEE_FACTOR,
                )
            ) {
                continue;
            }
        }

        // 5b-ter — parse ErgoTree. Reached only for NON-storage-rent spends:
        // a storage-rent spend (5b-bis above) is consensus-valid WITHOUT
        // deserializing the proposition (it keys off creationHeight expiry +
        // recreation rules over the raw ergoTreeBytes), so neither the JVM nor
        // sigma-rust parse the tree for it — and neither must we. iter-31:
        // box 551242f6… (h=1,596,890) had a version>activated junk tree
        // (cd07021a8e6f59fd4a) swept via storage rent; parsing it before the
        // storage-rent check wrongly halted the walker.
        let tree;
        try {
            tree = parseTree(ergoTreeBytes);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new HarnessError(
                'evaluate',
                'tree-parse-failed',
                `parseTree failed at tx ${txIndex}, input ${inputIndex}: ${message}`,
                location,
            );
        }

        // 5c — Cost-overflow guard (phase 2j-a). `oracleCost` arrives
        // as bigint (u64 source); we narrow to number for the cost-diff
        // comparison. Mainnet costs are far below `MAX_SAFE_INTEGER`;
        // overflowing values surface as a structured halt rather than a
        // silent precision loss.
        const oracleCostBig = input.oracleCost;
        if (oracleCostBig > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new HarnessError(
                'evaluate-cost',
                'cost-overflow',
                `oracleCost ${oracleCostBig} exceeds MAX_SAFE_INTEGER at tx ${txIndex}, input ${inputIndex}`,
                location,
            );
        }
        const oracleCost = Number(oracleCostBig);

        // 5d — evaluate via `evaluateWith(tree, ctx)` so the caller
        // holds `ctx` and can read `ctx.jitCost` post-eval for the
        // cost-diff sub-step. Per `facts/ergoscript-eval.md:256`,
        // `evaluateWith` does NOT auto-default `ctx.constants` from
        // `tree.constants`, so we set both `treeVersion` and `constants`
        // explicitly here (matching what `evaluate(tree, opts)` would
        // have done internally).
        const ctx = makeContext({
            height: block.height,
            selfBox,
            inputs: inputBoxes,
            outputs: outputBoxes,
            dataInputs: dataInputBoxes,
            preHeader,
            headers,
            // F5 batch 2 (2026-06-08): SContext.lastBlockUtxoRootHash (101:9) is
            // now an INDEPENDENT context field (JVM ErgoLikeContext.lastBlockUtxoRoot)
            // rather than headers-derived. The walker preserves the exact AvlTreeData
            // the old handler synthesized from headers[0].stateRoot (byte-identical:
            // digest, treeFlags 0b111, keyLength 32, valueLengthOpt null), so this is
            // behavior-preserving. `headers` is guaranteed non-empty here
            // (buildHeadersArray returns 10 or null; null returned early above).
            lastBlockUtxoRootHash: {
                digest: headers[0]!.stateRoot,
                treeFlags: 0b00000111,
                keyLength: 32,
                valueLengthOpt: null,
            },
            extension,
            jitCostLimit,
            treeVersion,
            constants: tree.constants,
        });
        let result: SValue;
        try {
            result = evaluateWith(tree, ctx);
        } catch (err) {
            const ourErrorMsg = formatOurError(err);
            // Phase 2j-a: if oracle succeeded but we threw, surface
            // 'ours-errored-oracle-succeeded'. `ctx.jitCost` holds the
            // partial cost up to (and including) the throw point per
            // `facts/ergoscript-eval.md:258`.
            if (input.oracleSucceeded) {
                throw new HarnessError(
                    'evaluate-oracle-mismatch',
                    'ours-errored-oracle-succeeded',
                    `our eval threw [${ourErrorMsg}] but oracle succeeded (cost ${oracleCost}) at tx ${txIndex}, input ${inputIndex}`,
                    location,
                    {
                        ourError: ourErrorMsg,
                        oracleError: null,
                        ourEvaluateCost: ctx.jitCost,
                    },
                );
            }
            // Both errored → existing 'evaluate' phase wrapping (lenient
            // err/err cross-comparison; tighter oracle-vs-ours error-code
            // equivalence is a 2j-a carry-forward).
            if (err instanceof EvalError) {
                // Distinguish "library coverage gap" from "tree did
                // something wrong" — operators triaging a not-yet-impl
                // throw want to see it called out vs. burying it as a
                // generic EvalError.
                const isNotImpl =
                    err.code === 'not-implemented-yet' ||
                    err.code.endsWith('-method-not-implemented');
                throw new HarnessError(
                    'evaluate',
                    isNotImpl ? 'evaluate-not-implemented' : 'evaluate-eval-error',
                    `evaluate threw EvalError[${err.code}] at tx ${txIndex}, input ${inputIndex}: ${err.message}` +
                        ` (oracle also errored: ${input.oracleError ?? '<no message>'}; our cost-at-throw ${ctx.jitCost}, oracle cost ${oracleCost})`,
                    location,
                    {
                        ourError: ourErrorMsg,
                        oracleError: input.oracleError,
                        ourEvaluateCost: ctx.jitCost,
                    },
                );
            }
            throw new HarnessError(
                'evaluate',
                'evaluate-threw',
                `evaluate threw non-EvalError at tx ${txIndex}, input ${inputIndex}: ${ourErrorMsg}`,
                location,
            );
        }

        // 5e — our eval succeeded. Phase 2j-a: if oracle errored,
        // surface 'ours-succeeded-oracle-errored'.
        if (!input.oracleSucceeded) {
            throw new HarnessError(
                'evaluate-oracle-mismatch',
                'ours-succeeded-oracle-errored',
                `oracle errored [${input.oracleError ?? '<no message>'}] but our eval succeeded (cost ${ctx.jitCost}) at tx ${txIndex}, input ${inputIndex}`,
                location,
                {
                    ourError: null,
                    oracleError: input.oracleError,
                    ourEvaluateCost: ctx.jitCost,
                },
            );
        }

        // 5f — both eval'd OK. Cost-diff.
        if (ctx.jitCost !== oracleCost) {
            throw new HarnessError(
                'evaluate-cost',
                'cost-drift',
                `cost-drift: oracle ${oracleCost} vs ours ${ctx.jitCost} (delta ${oracleCost - ctx.jitCost}) at tx ${txIndex}, input ${inputIndex}`,
                location,
                {
                    evaluateCost: {
                        expected: oracleCost,
                        actual: ctx.jitCost,
                        delta: oracleCost - ctx.jitCost,
                    },
                },
            );
        }

        // 5g — result must be SigmaProp. Any other kind means the
        // tree didn't reduce to a spending condition; halt.
        if (result.kind !== 'SigmaProp') {
            throw new HarnessError(
                'evaluate',
                'non-sigmaprop-result',
                `evaluate returned SValue.kind=${result.kind} at tx ${txIndex}, input ${inputIndex}; expected SigmaProp`,
                location,
            );
        }

        // 5h — verifier.
        let verified: boolean;
        try {
            verified = verifySignature(
                result.value,
                tx.signingMessage,
                input.signatureBytes,
            );
        } catch (err) {
            if (err instanceof VerifyError) {
                throw new HarnessError(
                    'verify-signature',
                    'verifier-threw',
                    `verifySignature threw VerifyError[${err.code}] at tx ${txIndex}, input ${inputIndex}: ${err.message}`,
                    location,
                );
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new HarnessError(
                'verify-signature',
                'verifier-threw',
                `verifySignature threw non-VerifyError at tx ${txIndex}, input ${inputIndex}: ${message}`,
                location,
            );
        }
        if (!verified) {
            throw new HarnessError(
                'verify-signature',
                'verifier-false',
                `verifySignature returned false at tx ${txIndex}, input ${inputIndex}`,
                location,
            );
        }
    }
}
