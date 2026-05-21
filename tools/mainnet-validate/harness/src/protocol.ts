/**
 * Wire-shape mirror of `tools/mainnet-validate/shim/src/protocol.rs`, plus a
 * `ShimClient` class that spawns the Rust shim subprocess and exposes typed
 * request methods on top of stdin (ASCII line) + stdout (length-prefixed
 * CBOR) framing.
 *
 * Wire shape comes directly from ciborium's serde-default emission of the
 * Rust structs; we re-derive the TS types from `shim/src/protocol.rs` rather
 * than from PLAN.md's older sketch (the sketch predates T5's documented
 * deviations — see Source Mapping notes below).
 *
 * # Source mapping (Rust → TS)
 *
 * | Rust struct                | TS type                  | Notes |
 * |----------------------------|--------------------------|-------|
 * | `BlockBundle`              | `BlockBundle`            | Camel-cased keys (cbor-x decodes the wire's snake_case keys; we re-key at the boundary). |
 * | `TxBundle`                 | `TxBundle`               | Same camelCase remap. |
 * | `InputBundle`              | `InputBundle`            | Carries `boxId` for diagnostic correlation — the harness MUST recompute `boxId` from `spentBoxBytes` via blake2b256 and reject if they disagree. The authoritative source for signing is always `spentBoxBytes`. |
 * | `ContextExtensionEntry`    | `ContextExtensionEntry`  | CBOR-array of struct-as-object — NOT a tuple. Shape `{varId, valueBytes}`. |
 * | `BlockParameters`          | `BlockParameters`        | `maxBlockCost: number \| null` — the parser downgrades parse failures to null per Rust `Option<BlockParameters>`. |
 * | `Vec<u8>` / `[u8; 32]`     | `Uint8Array`             | Ciborium emits both as CBOR major-type-4 (array of small ints), NOT byte strings. cbor-x decodes them as plain `number[]`; we convert at the boundary so downstream code can hash/compare via Uint8Array. |
 *
 * # cbor-x configuration
 *
 * `Decoder` must be instantiated with `{useRecords: false, mapsAsObjects: true}`:
 * - `useRecords: false` — without this, cbor-x returns a non-plain Record
 *   instance whose properties are not own-enumerable, breaking `JSON.stringify`
 *   and structured logging. Verified empirically (Decoder default returned `{}`
 *   when stringified despite holding `ok/data` properties).
 * - `mapsAsObjects: true` — the wire shape is CBOR map (major-type 5) and we
 *   want JS objects, not `Map` instances.
 *
 * # Error codes
 *
 * Strongly typed as a string-literal union so misclassification is a TS error.
 * Sourced from `shim/src/main.rs` + `shim/src/block_walker.rs` (the only sites
 * that emit `write_err(code, ...)`). Update both sides together if a new code
 * lands.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Decoder } from 'cbor-x';

/**
 * Stable error codes emitted by the shim on the wire.
 *
 * Sourced from grep of `write_err(` calls across `shim/src/main.rs` +
 * `shim/src/block_walker.rs`. Update this union AND the shim's emit sites
 * together if a new code lands.
 */
export type ShimErrorCode =
    | 'missing-block'
    | 'missing-utxo'
    | 'missing-data-utxo'
    | 'missing-section'
    | 'store-race'
    | 'past-indexed'
    | 'utxo-bootstrap-detected'
    | 'empty-store'
    | 'walker-error'
    | 'unknown-command';

/** Top-level CBOR shape: `{ok: true, data: T}` or `{ok: false, error}`. */
export type ShimResponse<T> =
    | { ok: true; data: T }
    | { ok: false; error: { code: ShimErrorCode; message: string } };

/** `GET_TIP_HEIGHT` payload. Mirrors `TipHeightResponse { tip: u32 }`. */
export interface TipHeightData {
    tip: number;
}

/** Single `(varId, serialized-Constant-bytes)` pair from a tx input's ContextExtension. */
export interface ContextExtensionEntry {
    varId: number;
    valueBytes: Uint8Array;
}

/** Per-input bundle. See Source Mapping note on `boxId` diagnostic role. */
export interface InputBundle {
    /**
     * 32 bytes; the canonical id of the input box. Diagnostic only — the
     * harness MUST recompute this from `spentBoxBytes` via blake2b256 and
     * reject on mismatch. Authoritative signing source is `spentBoxBytes`.
     */
    boxId: Uint8Array;
    spentBoxBytes: Uint8Array;
    signatureBytes: Uint8Array;
    contextExtension: ContextExtensionEntry[];
}

/** Per-transaction bundle. */
export interface TxBundle {
    txId: Uint8Array;
    signingMessage: Uint8Array;
    inputs: InputBundle[];
    outputs: Uint8Array[];
    dataInputBoxes: Uint8Array[];
}

/** Block-level voting/parameters snapshot extracted from the Extension section. */
export interface BlockParameters {
    maxBlockCost: number;
}

/** Per-block bundle emitted by `GET_BLOCK`. */
export interface BlockBundle {
    height: number;
    blockId: Uint8Array;
    parentId: Uint8Array;
    headerBytes: Uint8Array;
    transactions: TxBundle[];
    parameters: BlockParameters | null;
}

/**
 * Structured error raised when the shim replies with `{ok: false, ...}`.
 * Preserved as a TS class so `instanceof ShimError` works in `catch` arms.
 */
export class ShimError extends Error {
    constructor(
        public readonly code: ShimErrorCode,
        message: string,
    ) {
        super(`shim error [${code}]: ${message}`);
        this.name = 'ShimError';
    }
}

/**
 * Convert a `number[]` (cbor-x's decoding of CBOR major-type-4 array of
 * small ints) into a `Uint8Array`. Validates that every element is in the
 * byte range — otherwise we'd silently mask corrupted data with `& 0xff`
 * truncation, which would defeat the harness's purpose.
 *
 * cbor-x DOES decode CBOR major-type-2 (byte strings) as `Uint8Array`
 * directly, so this function is a no-op pass-through when the input is
 * already `Uint8Array`. Required because ciborium's default serde emission
 * for `Vec<u8>` / `[u8; N]` is array-of-int rather than byte-string.
 */
function toByteArray(value: unknown, fieldPath: string): Uint8Array {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (Array.isArray(value)) {
        const out = new Uint8Array(value.length);
        for (let i = 0; i < value.length; i++) {
            const v = value[i];
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
                throw new TypeError(
                    `${fieldPath}[${i}]: expected byte 0..255, got ${String(v)} (${typeof v})`,
                );
            }
            out[i] = v;
        }
        return out;
    }
    throw new TypeError(
        `${fieldPath}: expected Uint8Array or number[], got ${value === null ? 'null' : typeof value}`,
    );
}

/**
 * Re-key + re-type the raw cbor-x output for `BlockBundle`. The shim emits
 * snake_case Rust struct keys, but the TS types use camelCase by convention,
 * so we transform at the boundary.
 *
 * Validates the shape — any divergence (missing key, wrong type) throws,
 * which surfaces wire-shape drift between the shim and harness immediately
 * rather than silently producing `undefined` downstream.
 */
function reKeyBlockBundle(raw: unknown): BlockBundle {
    if (raw === null || typeof raw !== 'object') {
        throw new TypeError(`BlockBundle: expected object, got ${typeof raw}`);
    }
    const r = raw as Record<string, unknown>;
    const txsRaw = r['transactions'];
    if (!Array.isArray(txsRaw)) {
        throw new TypeError(`BlockBundle.transactions: expected array, got ${typeof txsRaw}`);
    }
    const transactions = txsRaw.map((tx, i) => reKeyTxBundle(tx, `transactions[${i}]`));

    const paramsRaw = r['parameters'];
    let parameters: BlockParameters | null;
    if (paramsRaw === null || paramsRaw === undefined) {
        parameters = null;
    } else if (typeof paramsRaw === 'object') {
        const p = paramsRaw as Record<string, unknown>;
        const mbc = p['max_block_cost'];
        if (typeof mbc !== 'number' || !Number.isInteger(mbc)) {
            throw new TypeError(
                `parameters.max_block_cost: expected integer, got ${typeof mbc}`,
            );
        }
        parameters = { maxBlockCost: mbc };
    } else {
        throw new TypeError(
            `parameters: expected object or null, got ${typeof paramsRaw}`,
        );
    }

    if (typeof r['height'] !== 'number') {
        throw new TypeError(`height: expected number, got ${typeof r['height']}`);
    }
    return {
        height: r['height'] as number,
        blockId: toByteArray(r['block_id'], 'block_id'),
        parentId: toByteArray(r['parent_id'], 'parent_id'),
        headerBytes: toByteArray(r['header_bytes'], 'header_bytes'),
        transactions,
        parameters,
    };
}

function reKeyTxBundle(raw: unknown, path: string): TxBundle {
    if (raw === null || typeof raw !== 'object') {
        throw new TypeError(`${path}: expected object, got ${typeof raw}`);
    }
    const r = raw as Record<string, unknown>;
    const inputsRaw = r['inputs'];
    if (!Array.isArray(inputsRaw)) {
        throw new TypeError(`${path}.inputs: expected array, got ${typeof inputsRaw}`);
    }
    const outputsRaw = r['outputs'];
    if (!Array.isArray(outputsRaw)) {
        throw new TypeError(`${path}.outputs: expected array, got ${typeof outputsRaw}`);
    }
    const dataInputsRaw = r['data_input_boxes'];
    if (!Array.isArray(dataInputsRaw)) {
        throw new TypeError(
            `${path}.data_input_boxes: expected array, got ${typeof dataInputsRaw}`,
        );
    }
    return {
        txId: toByteArray(r['tx_id'], `${path}.tx_id`),
        signingMessage: toByteArray(r['signing_message'], `${path}.signing_message`),
        inputs: inputsRaw.map((inp, i) => reKeyInputBundle(inp, `${path}.inputs[${i}]`)),
        outputs: outputsRaw.map((out, i) =>
            toByteArray(out, `${path}.outputs[${i}]`),
        ),
        dataInputBoxes: dataInputsRaw.map((dib, i) =>
            toByteArray(dib, `${path}.data_input_boxes[${i}]`),
        ),
    };
}

function reKeyInputBundle(raw: unknown, path: string): InputBundle {
    if (raw === null || typeof raw !== 'object') {
        throw new TypeError(`${path}: expected object, got ${typeof raw}`);
    }
    const r = raw as Record<string, unknown>;
    const ctxRaw = r['context_extension'];
    if (!Array.isArray(ctxRaw)) {
        throw new TypeError(
            `${path}.context_extension: expected array, got ${typeof ctxRaw}`,
        );
    }
    return {
        boxId: toByteArray(r['box_id'], `${path}.box_id`),
        spentBoxBytes: toByteArray(r['spent_box_bytes'], `${path}.spent_box_bytes`),
        signatureBytes: toByteArray(r['signature_bytes'], `${path}.signature_bytes`),
        contextExtension: ctxRaw.map((entry, i) =>
            reKeyContextExtensionEntry(entry, `${path}.context_extension[${i}]`),
        ),
    };
}

function reKeyContextExtensionEntry(raw: unknown, path: string): ContextExtensionEntry {
    if (raw === null || typeof raw !== 'object') {
        throw new TypeError(`${path}: expected object, got ${typeof raw}`);
    }
    const r = raw as Record<string, unknown>;
    const varId = r['var_id'];
    if (typeof varId !== 'number' || !Number.isInteger(varId) || varId < 0 || varId > 255) {
        throw new TypeError(
            `${path}.var_id: expected u8, got ${typeof varId} (${String(varId)})`,
        );
    }
    return {
        varId,
        valueBytes: toByteArray(r['value_bytes'], `${path}.value_bytes`),
    };
}

/**
 * Frame parser state. The shim emits a 4-byte big-endian length prefix
 * followed by N bytes of CBOR. stdout chunks arrive arbitrarily fragmented
 * so we buffer until we have a complete frame.
 *
 * Single-frame extraction (no batch). Callers consume one frame per request
 * since the shim is single-threaded request/response — concurrent in-flight
 * requests are not supported.
 */
class FrameBuffer {
    private buf: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): void {
        this.buf = Buffer.concat([this.buf, chunk]);
    }

    /** Pop one complete frame's body bytes (without the length prefix), or null if incomplete. */
    pop(): Buffer | null {
        if (this.buf.length < 4) {
            return null;
        }
        const len = this.buf.readUInt32BE(0);
        if (this.buf.length < 4 + len) {
            return null;
        }
        const body = this.buf.subarray(4, 4 + len);
        // Detach: copy out before truncating the underlying buffer so the
        // caller's reference doesn't share memory with our next read.
        const out = Buffer.from(body);
        this.buf = this.buf.subarray(4 + len);
        return out;
    }
}

/**
 * Long-lived client for the Rust shim subprocess.
 *
 * # Lifecycle
 *
 * 1. `await ShimClient.spawn(shimPath, storePath, sidecarPath)` — launches
 *    the shim with the two store paths as argv. Stdin/stdout are piped;
 *    stderr is forwarded to the parent's stderr so shim diagnostics
 *    (e.g. startup banner, walker progress) are visible.
 * 2. `await client.getTipHeight()` / `await client.getBlock(height)` —
 *    serialized request/response. Concurrent calls are rejected.
 * 3. `await client.close()` — sends SIGTERM, awaits exit.
 *
 * # Error semantics
 *
 * - Shim emits `{ok: false, error}` → method throws `ShimError`.
 * - Shim crashes / exits unexpectedly → in-flight promise rejects with an
 *   `Error` carrying the exit code or signal.
 * - Wire-shape divergence (missing field, wrong type) → method throws
 *   `TypeError` from the re-key/validate layer.
 *
 * # Concurrency
 *
 * The shim is single-threaded. We enforce this on the harness side via
 * an `inFlight` guard — overlapping requests throw immediately rather than
 * interleaving on the wire.
 */
export class ShimClient {
    private readonly proc: ChildProcessWithoutNullStreams;
    private readonly frames: FrameBuffer = new FrameBuffer();
    private readonly decoder: Decoder;
    private pendingResolver: ((body: Buffer) => void) | null = null;
    private pendingRejecter: ((err: Error) => void) | null = null;
    private inFlight = false;
    private exited = false;
    private exitError: Error | null = null;

    private constructor(proc: ChildProcessWithoutNullStreams) {
        this.proc = proc;
        this.decoder = new Decoder({ useRecords: false, mapsAsObjects: true });

        this.proc.stdout.on('data', (chunk: Buffer) => {
            this.frames.push(chunk);
            const body = this.frames.pop();
            if (body !== null && this.pendingResolver !== null) {
                const resolve = this.pendingResolver;
                this.pendingResolver = null;
                this.pendingRejecter = null;
                resolve(body);
            }
        });

        this.proc.stderr.on('data', (chunk: Buffer) => {
            process.stderr.write(chunk);
        });

        this.proc.on('exit', (code, signal) => {
            this.exited = true;
            const reason =
                code !== null
                    ? `shim exited with code ${code}`
                    : `shim killed by signal ${signal ?? 'unknown'}`;
            this.exitError = new Error(reason);
            if (this.pendingRejecter !== null) {
                const reject = this.pendingRejecter;
                this.pendingResolver = null;
                this.pendingRejecter = null;
                reject(this.exitError);
            }
        });

        this.proc.on('error', (err) => {
            this.exitError = err;
            if (this.pendingRejecter !== null) {
                const reject = this.pendingRejecter;
                this.pendingResolver = null;
                this.pendingRejecter = null;
                reject(err);
            }
        });
    }

    /** Spawn the shim subprocess. Does NOT wait for any startup readiness signal — the first request will block on stdout. */
    static spawn(shimPath: string, storePath: string, sidecarPath: string): ShimClient {
        const proc = spawn(shimPath, [storePath, sidecarPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return new ShimClient(proc);
    }

    /** Send one request line + await one framed CBOR response. */
    private async request<T>(line: string): Promise<T> {
        if (this.inFlight) {
            throw new Error(
                'ShimClient: concurrent requests not supported (shim is single-threaded)',
            );
        }
        if (this.exited) {
            throw this.exitError ?? new Error('ShimClient: shim has exited');
        }
        this.inFlight = true;
        try {
            const body = await new Promise<Buffer>((resolve, reject) => {
                this.pendingResolver = resolve;
                this.pendingRejecter = reject;
                this.proc.stdin.write(line, (err) => {
                    if (err !== null && err !== undefined) {
                        this.pendingResolver = null;
                        this.pendingRejecter = null;
                        reject(err);
                    }
                });
            });
            const raw = this.decoder.decode(body) as Record<string, unknown>;
            if (raw['ok'] === true) {
                return raw['data'] as T;
            }
            if (raw['ok'] === false) {
                const err = raw['error'] as Record<string, unknown> | undefined;
                const code = (err?.['code'] as ShimErrorCode | undefined) ?? 'walker-error';
                const message = (err?.['message'] as string | undefined) ?? '<no message>';
                throw new ShimError(code, message);
            }
            throw new TypeError(
                `ShimClient: response missing/invalid \`ok\` field: ${JSON.stringify(raw)}`,
            );
        } finally {
            this.inFlight = false;
        }
    }

    /** `GET_TIP_HEIGHT` — returns the modifier store's best-header tip height. */
    async getTipHeight(): Promise<number> {
        const data = await this.request<TipHeightData>('GET_TIP_HEIGHT\n');
        if (typeof data.tip !== 'number' || !Number.isInteger(data.tip)) {
            throw new TypeError(
                `getTipHeight: expected integer tip, got ${typeof data.tip} (${String(data.tip)})`,
            );
        }
        return data.tip;
    }

    /** `GET_BLOCK <height>` — returns the full BlockBundle for the given height. */
    async getBlock(height: number): Promise<BlockBundle> {
        if (!Number.isInteger(height) || height < 0) {
            throw new TypeError(`getBlock: height must be a non-negative integer, got ${height}`);
        }
        const data = await this.request<unknown>(`GET_BLOCK ${height}\n`);
        return reKeyBlockBundle(data);
    }

    /** Send SIGTERM and await exit. Safe to call multiple times. */
    async close(): Promise<void> {
        if (this.exited) {
            return;
        }
        return new Promise<void>((resolve) => {
            this.proc.once('exit', () => {
                resolve();
            });
            this.proc.kill('SIGTERM');
        });
    }
}
