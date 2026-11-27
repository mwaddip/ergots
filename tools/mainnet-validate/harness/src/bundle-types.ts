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
    /** Canonical serialized tx bytes — attached by the assembler only in the lib
     *  and ids modes (`--mode lib|ids`), consumed by `parseTransaction` in
     *  validate-tx-lib and validate-tx-ids. */
    txBytes?: Uint8Array;
}

export interface BlockParameters {
    maxBlockCost: number;
    /** The voted block version, parameter 123 `BlockVersion` of the current
     *  voting epoch (ergo `settings/Parameters.scala:80`, `:255`). Written
     *  by the ergo node into the extension of an epoch's first block under
     *  the system-parameters prefix with `Ints.toByteArray` (key `007b`,
     *  four bytes big-endian). The JVM reads it as its `Byte`
     *  (`parametersTable(BlockVersion).toByte`); the Int comes through here,
     *  and `validateStateful` wraps it as a signed byte. Below the first
     *  epoch start it is the network's launch value: 1 on mainnet, 4 on the
     *  public testnet (`LaunchParameters.scala:8-17`). */
    blockVersion: number;
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
    /** The section's own block version marker
     *  (`/blocks/{id}.blockTransactions.blockVersion`): the context a node
     *  reads a block's transactions under (ergo `BlockTransactions.scala:184-202`).
     *  From ergo 6.0.8 a section whose marker differs from its header's
     *  version is refused (`bsCorrespondsToHeader`, `Header.scala:104-108`),
     *  and the assembler halts the walk there. */
    sectionBlockVersion: number;
}
