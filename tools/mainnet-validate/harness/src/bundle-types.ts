/**
 * Bundle types for the mainnet-validate harness. Same shape as the
 * legacy CBOR shim's protocol.ts BlockBundle (camelCase, Uint8Array
 * fields), kept stable so the validation pipeline doesn't change
 * between architectures. Bundles are now assembled in-memory by
 * bundle-assembler.ts from REST fragments + indexer-served box bytes
 * + WasmCostOracle results.
 */

export interface ContextExtensionEntry {
    varId: number;
    valueBytes: Uint8Array;
}

export interface InputBundle {
    boxId: Uint8Array;
    spentBoxBytes: Uint8Array;
    signatureBytes: Uint8Array;
    contextExtension: ContextExtensionEntry[];
    oracleCost: bigint;
    oracleSucceeded: boolean;
    oracleError: string | null;
}

export interface TxBundle {
    txId: Uint8Array;
    signingMessage: Uint8Array;
    inputs: InputBundle[];
    outputs: Uint8Array[];
    dataInputBoxes: Uint8Array[];
    /** Canonical serialized tx bytes — attached by the assembler only in lib-mode
     *  (`--mode lib`), consumed by validate-tx-lib's `parseTransaction`. */
    txBytes?: Uint8Array;
}

export interface BlockParameters {
    maxBlockCost: number;
}

export interface BlockBundle {
    height: number;
    blockId: Uint8Array;
    parentId: Uint8Array;
    headerBytes: Uint8Array;
    /** JSON-string form of the block's header (from /blocks/{id}.header).
     *  Needed by the walk loop to feed forward into next block's
     *  WasmCostOracle.computeTxOracleCosts rolling-headers window. */
    headerJson: string;
    transactions: TxBundle[];
    parameters: BlockParameters | null;
}
