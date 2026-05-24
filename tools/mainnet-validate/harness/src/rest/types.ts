/**
 * Defensive JSON-response parsers for node + indexer REST surfaces.
 *
 * Each parser validates only the fields the harness depends on and throws
 * `TypeError` with a field-path message on shape divergence — so wire drift
 * surfaces at the boundary rather than as a confusing failure deep in the
 * pipeline. Parsers are tolerant of unknown additional fields (the node may
 * grow new fields over time and we shouldn't reject those).
 *
 * Per PLAN-2j-rest.md T3 + spec §5.
 */

export interface InfoResponse {
    fullHeight: number;
    bestHeaderId: string;
    network: 'mainnet' | 'testnet';
}

export type HeaderIdsAtHeightResponse = string[];

export interface HeaderJson {
    id: string;
    height: number;
    parentId: string;
    version: number;
    /**
     * Full node-response header JSON string, preserved verbatim from the
     * /blocks/{id} response body. Required by WasmCostOracle.computeTxOracleCosts
     * (BlockHeader.from_json expects the complete header including adProofsRoot,
     * transactionsRoot, stateRoot, extensionHash, powSolutions, votes, nBits,
     * timestamp, unparsedBytes). Only the 4 typed fields above are validated by
     * parseBlockResponse; the rest are passed through opaquely to the WASM layer.
     */
    rawJson: string;
}

export interface InputJson {
    boxId: string;
    spendingProof: { proofBytes: string; extension: Record<string, string> };
}

export interface OutputJson {
    boxId: string;
    /**
     * Box value in nanoERG. Left as raw `number | string` because mainnet
     * values exceed `Number.MAX_SAFE_INTEGER` (e.g. h=2 emission box value is
     * 93_408_997_500_000_000). Downstream code must convert to bigint before
     * arithmetic — never widen here.
     */
    value: number | string;
    ergoTree: string;
    creationHeight: number;
    transactionId: string;
    index: number;
    assets: Array<{ tokenId: string; amount: number | string }>;
    additionalRegisters: Record<string, string>;
}

export interface TransactionJson {
    id: string;
    inputs: InputJson[];
    dataInputs: { boxId: string }[];
    outputs: OutputJson[];
}

export interface BlockResponse {
    header: HeaderJson;
    blockTransactions: { transactions: TransactionJson[] };
    extension: { fields: Array<[string, string]> };
}

export interface ValidationFragmentsResponse {
    headerBytes: string;
    parameters: { maxBlockCost: number } | null;
    transactions: Array<{ signingMessage: string }>;
}

export interface BoxBytesResponse {
    bytes: string;
}

// --- parser helpers ---

function describe(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return `array(len=${v.length})`;
    return typeof v;
}

function asObject(v: unknown, path: string): Record<string, unknown> {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw new TypeError(`${path}: expected object, got ${describe(v)}`);
    }
    return v as Record<string, unknown>;
}

function asArray(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) {
        throw new TypeError(`${path}: expected array, got ${describe(v)}`);
    }
    return v;
}

function asString(v: unknown, path: string): string {
    if (typeof v !== 'string') {
        throw new TypeError(`${path}: expected string, got ${describe(v)}`);
    }
    return v;
}

function asInt(v: unknown, path: string): number {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new TypeError(`${path}: expected integer, got ${describe(v)}`);
    }
    return v;
}

// --- response parsers ---

export function parseInfoResponse(raw: unknown): InfoResponse {
    const o = asObject(raw, '/info');
    return {
        fullHeight: asInt(o['fullHeight'], '/info.fullHeight'),
        bestHeaderId: asString(o['bestHeaderId'], '/info.bestHeaderId'),
        network: asString(o['network'], '/info.network') as 'mainnet' | 'testnet',
    };
}

export function parseHeaderIdsAtHeightResponse(raw: unknown): HeaderIdsAtHeightResponse {
    const arr = asArray(raw, '/blocks/at/{h}');
    return arr.map((v, i) => asString(v, `/blocks/at/{h}[${i}]`));
}

export function parseBlockResponse(raw: unknown): BlockResponse {
    const o = asObject(raw, '/blocks/{id}');
    const h = asObject(o['header'], '/blocks/{id}.header');
    const bt = asObject(o['blockTransactions'], '/blocks/{id}.blockTransactions');
    const txs = asArray(bt['transactions'], '/blocks/{id}.blockTransactions.transactions');
    const ext = asObject(o['extension'], '/blocks/{id}.extension');
    const fields = asArray(ext['fields'], '/blocks/{id}.extension.fields');
    return {
        header: {
            id: asString(h['id'], '/blocks/{id}.header.id'),
            height: asInt(h['height'], '/blocks/{id}.header.height'),
            parentId: asString(h['parentId'], '/blocks/{id}.header.parentId'),
            version: asInt(h['version'], '/blocks/{id}.header.version'),
            // Preserve the full raw header JSON for WasmCostOracle.
            // JSON.stringify round-trip normalises the object (removes undefined,
            // converts bigints to strings) but preserves all other fields verbatim.
            rawJson: JSON.stringify(o['header']),
        },
        blockTransactions: {
            transactions: txs.map((tx, i) =>
                parseTxJson(tx, `/blocks/{id}.blockTransactions.transactions[${i}]`),
            ),
        },
        extension: {
            fields: fields.map((f, i) => {
                const p = asArray(f, `/blocks/{id}.extension.fields[${i}]`);
                if (p.length !== 2) {
                    throw new TypeError(
                        `/blocks/{id}.extension.fields[${i}]: expected [key, value] pair, got length ${p.length}`,
                    );
                }
                return [
                    asString(p[0], `/blocks/{id}.extension.fields[${i}][0]`),
                    asString(p[1], `/blocks/{id}.extension.fields[${i}][1]`),
                ] as [string, string];
            }),
        },
    };
}

function parseTxJson(raw: unknown, path: string): TransactionJson {
    const o = asObject(raw, path);
    const inputs = asArray(o['inputs'], `${path}.inputs`).map((i, ii) => {
        const inp = asObject(i, `${path}.inputs[${ii}]`);
        const sp = asObject(inp['spendingProof'], `${path}.inputs[${ii}].spendingProof`);
        const extRaw = sp['extension'];
        const ext =
            extRaw === undefined || extRaw === null
                ? {}
                : asObject(extRaw, `${path}.inputs[${ii}].spendingProof.extension`);
        const extObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(ext)) {
            extObj[k] = asString(v, `${path}.inputs[${ii}].spendingProof.extension.${k}`);
        }
        return {
            boxId: asString(inp['boxId'], `${path}.inputs[${ii}].boxId`),
            spendingProof: {
                proofBytes: asString(sp['proofBytes'], `${path}.inputs[${ii}].spendingProof.proofBytes`),
                extension: extObj,
            },
        };
    });
    const dataInputs = asArray(o['dataInputs'], `${path}.dataInputs`).map((d, di) => ({
        boxId: asString(
            asObject(d, `${path}.dataInputs[${di}]`)['boxId'],
            `${path}.dataInputs[${di}].boxId`,
        ),
    }));
    const outputs = asArray(o['outputs'], `${path}.outputs`).map((out, oi) => {
        const ob = asObject(out, `${path}.outputs[${oi}]`);
        return {
            boxId: asString(ob['boxId'], `${path}.outputs[${oi}].boxId`),
            // value: see OutputJson docstring — left as raw number|string.
            value: ob['value'] as number | string,
            ergoTree: asString(ob['ergoTree'], `${path}.outputs[${oi}].ergoTree`),
            creationHeight: asInt(ob['creationHeight'], `${path}.outputs[${oi}].creationHeight`),
            transactionId: asString(ob['transactionId'], `${path}.outputs[${oi}].transactionId`),
            index: asInt(ob['index'], `${path}.outputs[${oi}].index`),
            assets: asArray(ob['assets'], `${path}.outputs[${oi}].assets`).map((a, ai) => {
                const ao = asObject(a, `${path}.outputs[${oi}].assets[${ai}]`);
                return {
                    tokenId: asString(
                        ao['tokenId'],
                        `${path}.outputs[${oi}].assets[${ai}].tokenId`,
                    ),
                    // amount can exceed MAX_SAFE_INTEGER; leave as raw number|string.
                    amount: ao['amount'] as number | string,
                };
            }),
            additionalRegisters: ((): Record<string, string> => {
                const ar = ob['additionalRegisters'];
                if (ar === null || ar === undefined) return {};
                const aro = asObject(ar, `${path}.outputs[${oi}].additionalRegisters`);
                const out: Record<string, string> = {};
                for (const [k, v] of Object.entries(aro)) {
                    out[k] = asString(v, `${path}.outputs[${oi}].additionalRegisters.${k}`);
                }
                return out;
            })(),
        };
    });
    return { id: asString(o['id'], `${path}.id`), inputs, dataInputs, outputs };
}

export function parseValidationFragmentsResponse(raw: unknown): ValidationFragmentsResponse {
    const o = asObject(raw, '/blocks/{id}/validation-fragments');
    // Validate headerBytes first — it is the primary load-bearing field and we
    // want the error message to surface on it before downstream fields.
    const headerBytes = asString(
        o['headerBytes'],
        '/blocks/{id}/validation-fragments.headerBytes',
    );
    const params = o['parameters'];
    let parameters: ValidationFragmentsResponse['parameters'];
    if (params === null || params === undefined) {
        parameters = null;
    } else {
        const po = asObject(params, '/blocks/{id}/validation-fragments.parameters');
        parameters = {
            maxBlockCost: asInt(
                po['maxBlockCost'],
                '/blocks/{id}/validation-fragments.parameters.maxBlockCost',
            ),
        };
    }
    const txs = asArray(o['transactions'], '/blocks/{id}/validation-fragments.transactions');
    return {
        headerBytes,
        parameters,
        transactions: txs.map((t, i) => ({
            signingMessage: asString(
                asObject(t, `/blocks/{id}/validation-fragments.transactions[${i}]`)['signingMessage'],
                `/blocks/{id}/validation-fragments.transactions[${i}].signingMessage`,
            ),
        })),
    };
}

export function parseBoxBytesResponse(raw: unknown): BoxBytesResponse {
    const o = asObject(raw, '/api/v1/boxes/{id}/bytes');
    return { bytes: asString(o['bytes'], '/api/v1/boxes/{id}/bytes.bytes') };
}
