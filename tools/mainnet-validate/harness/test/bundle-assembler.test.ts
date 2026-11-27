import { describe, it, expect, vi } from 'vitest';
import { BundleAssembler } from '../src/bundle-assembler.js';

/** Build a /blocks/{id} mock response with the given header version and section marker. */
function mkBlock(opts: {
    blockId: string;
    height: number;
    headerVersion?: number;
    sectionBlockVersion?: number;
    extensionFields?: Array<[string, string]>;
}) {
    const version = opts.headerVersion ?? 1;
    const sectionBlockVersion = opts.sectionBlockVersion ?? version;
    const rawJson = JSON.stringify({ id: opts.blockId, height: opts.height, parentId: '00'.repeat(32), version });
    return {
        header: { id: opts.blockId, height: opts.height, parentId: '00'.repeat(32), version, rawJson },
        blockTransactions: {
            blockVersion: sectionBlockVersion,
            transactions: [{
                id: 'bb'.repeat(32),
                inputs: [{ boxId: 'cc'.repeat(32), spendingProof: { proofBytes: '', extension: {} } }],
                dataInputs: [],
                outputs: [{ boxId: 'dd'.repeat(32), value: 100, ergoTree: '00', creationHeight: opts.height, transactionId: 'bb'.repeat(32), index: 0, assets: [], additionalRegisters: {} }],
            }],
        },
        extension: { fields: opts.extensionFields ?? [] },
    };
}

describe('BundleAssembler', () => {
    it('assembles BlockBundle from node + indexer + oracle mocks', async () => {
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue(['aa'.repeat(32)]),
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId: 'aa'.repeat(32), height: 2 })),
            getValidationFragments: vi.fn().mockResolvedValue({
                headerBytes: 'ab'.repeat(100),
                parameters: { maxBlockCost: 1_000_000 },
                transactions: [{ signingMessage: 'cd'.repeat(50) }],
            }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any);
        const bundle = await a.assemble(2, []);
        expect(bundle.height).toBe(2);
        expect(bundle.transactions.length).toBe(1);
        expect(bundle.transactions[0]!.inputs[0]!.oracleCost).toBe(50n);
        expect(bundle.parameters?.maxBlockCost).toBe(1_000_000);
        expect(bundle.headerJson).toBeTypeOf('string');
        expect(JSON.parse(bundle.headerJson).height).toBe(2);
        expect(indexer.getBoxBytes).toHaveBeenCalledWith('cc'.repeat(32));
        expect(indexer.getBoxBytes).toHaveBeenCalledWith('dd'.repeat(32));
    });

    it('derives active maxBlockCost from the epoch boundary when the block carries null params (iter-26)', async () => {
        const H = 1_144_466;          // non-boundary
        const BOUNDARY = 1_143_808;   // ⌊H/1024⌋·1024
        const blockId = 'aa'.repeat(32);
        const boundaryId = 'ee'.repeat(32);
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockImplementation(async (h: number) =>
                h === H ? [blockId] : h === BOUNDARY ? [boundaryId] : []),
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId, height: H })),
            // block id → null params (non-boundary); boundary id → the active value
            getValidationFragments: vi.fn().mockImplementation(async (id: string) =>
                id === blockId
                    ? { headerBytes: 'ab'.repeat(100), parameters: null, transactions: [{ signingMessage: 'cd'.repeat(50) }] }
                    : { headerBytes: 'ab'.repeat(100), parameters: { maxBlockCost: 8_001_091 }, transactions: [] }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any);
        const bundle = await a.assemble(H, []);
        // resolved from boundary 1,143,808, NOT the 1,000,000 genesis fallback
        expect(bundle.parameters?.maxBlockCost).toBe(8_001_091);
        expect(node.getHeaderIdsAtHeight).toHaveBeenCalledWith(BOUNDARY);
        // the oracle gets the resolved active value too, so its cost limit
        // (maxBlockCost×10) matches the evaluator's (iter-27)
        expect(oracle.computeTxOracleCosts).toHaveBeenCalledWith(
            expect.objectContaining({ parameters: { maxBlockCost: 8_001_091 } }),
        );
    });

    it('lib-mode: attaches the TRUE on-chain tx bytes from validation-fragments, not serializeTx (CAP-A)', async () => {
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue(['aa'.repeat(32)]),
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId: 'aa'.repeat(32), height: 2 })),
            getValidationFragments: vi.fn().mockResolvedValue({
                headerBytes: 'ab'.repeat(100),
                parameters: { maxBlockCost: 1_000_000 },
                // true on-chain bytes carry the wire-order extension; serializeTx would re-sort it.
                transactions: [{ signingMessage: 'cd'.repeat(50), bytes: '0a0b0c' }],
            }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        // serializeTx MUST NOT be called in lib-mode — the bytes come from fragments.
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 0n, oracleSucceeded: true, oracleError: null }]),
            serializeTx: vi.fn(),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any, /* attachTxBytes */ true);
        const bundle = await a.assemble(2, []);
        expect(bundle.transactions[0]!.txBytes).toEqual(Uint8Array.from([0x0a, 0x0b, 0x0c]));
        expect(oracle.serializeTx).not.toHaveBeenCalled();
        // lib-mode also bypasses the cost oracle entirely (spec decision 3).
        expect(oracle.computeTxOracleCosts).not.toHaveBeenCalled();
    });

    it('lib-mode: throws a clear error when validation-fragments omits per-tx bytes', async () => {
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue(['aa'.repeat(32)]),
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId: 'aa'.repeat(32), height: 2 })),
            getValidationFragments: vi.fn().mockResolvedValue({
                headerBytes: 'ab'.repeat(100),
                parameters: { maxBlockCost: 1_000_000 },
                transactions: [{ signingMessage: 'cd'.repeat(50) }], // no bytes
            }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = { computeTxOracleCosts: vi.fn(), serializeTx: vi.fn() };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any, true);
        await expect(a.assemble(2, [])).rejects.toThrow(/bytes/);
    });

    it('falls back to the genesis default when the boundary block is unavailable (iter-26 genesis-epoch edge)', async () => {
        const H = 5;                  // genesis epoch → boundary 0 (doesn't exist)
        const blockId = 'aa'.repeat(32);
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockImplementation(async (h: number) => {
                if (h === H) return [blockId];
                throw new Error('unexpected-status');  // boundary 0 not served
            }),
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId, height: H })),
            getValidationFragments: vi.fn().mockResolvedValue({
                headerBytes: 'ab'.repeat(100), parameters: null, transactions: [{ signingMessage: 'cd'.repeat(50) }],
            }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any);
        const bundle = await a.assemble(H, []);
        expect(bundle.parameters?.maxBlockCost).toBe(1_000_000);  // genesis default, no halt
    });

    it('resolves the voted block version from the extension key 007b of the epoch boundary, cached per epoch', async () => {
        const H = 1_144_466;
        const BOUNDARY = 1_143_808;
        const blockId = 'aa'.repeat(32);
        const boundaryId = 'ee'.repeat(32);
        const extFields: Array<[string, string]> = [
            ['0004', '00000001'],        // some other parameter
            ['007b', '00000005'],        // parameter 123 BlockVersion = 5, 4 bytes BE
        ];
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockImplementation(async (h: number) =>
                h === H ? [blockId] : h === BOUNDARY ? [boundaryId] : []),
            getBlock: vi.fn().mockImplementation(async (id: string) =>
                id === blockId
                    ? mkBlock({ blockId, height: H })
                    : mkBlock({ blockId: boundaryId, height: BOUNDARY, extensionFields: extFields })),
            getValidationFragments: vi.fn().mockImplementation(async (id: string) =>
                id === blockId
                    ? { headerBytes: 'ab'.repeat(100), parameters: null, transactions: [{ signingMessage: 'cd'.repeat(50) }] }
                    : { headerBytes: 'ab'.repeat(100), parameters: { maxBlockCost: 8_001_091 }, transactions: [] }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any, false, 'mainnet');
        const bundle = await a.assemble(H, []);
        expect(bundle.parameters?.blockVersion).toBe(5);

        // Second call in the same epoch must hit both per-epoch caches
        // (maxBlockCost and blockVersion) without refetching the boundary.
        // The first assemble() walks back for each resolver once; the second
        // adds no boundary fetches. So two assemble() calls for the same
        // height produce two boundary fetches, not four.
        await a.assemble(H, []);
        const boundaryCalls = node.getHeaderIdsAtHeight.mock.calls.filter((c: any[]) => c[0] === BOUNDARY).length;
        expect(boundaryCalls).toBe(2);
    });

    it('reads a 128-or-above voted block version through as an unwrapped Int (the caller takes .toByte)', async () => {
        const H = 1_144_466;
        const BOUNDARY = 1_143_808;
        const blockId = 'aa'.repeat(32);
        const boundaryId = 'ee'.repeat(32);
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockImplementation(async (h: number) =>
                h === H ? [blockId] : h === BOUNDARY ? [boundaryId] : []),
            getBlock: vi.fn().mockImplementation(async (id: string) =>
                id === blockId
                    ? mkBlock({ blockId, height: H })
                    : mkBlock({ blockId: boundaryId, height: BOUNDARY, extensionFields: [['007b', '00000080']] /* Int 128 */ })),
            getValidationFragments: vi.fn().mockImplementation(async (id: string) =>
                id === blockId
                    ? { headerBytes: 'ab'.repeat(100), parameters: null, transactions: [{ signingMessage: 'cd'.repeat(50) }] }
                    : { headerBytes: 'ab'.repeat(100), parameters: { maxBlockCost: 8_001_091 }, transactions: [] }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any, false, 'mainnet');
        const bundle = await a.assemble(H, []);
        // Int 128, the JVM's parametersTable(BlockVersion) before .toByte;
        // validateStateful's signedBlockVersion wraps it.
        expect(bundle.parameters?.blockVersion).toBe(128);
    });

    it('below the first epoch start, takes the launch value: 1 on mainnet', async () => {
        const H = 500;   // below the first boundary (1024)
        const blockId = 'aa'.repeat(32);
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockImplementation(async (h: number) => {
                if (h === H) return [blockId];
                throw new Error('unexpected-status');   // boundary 0 unavailable
            }),
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId, height: H })),
            getValidationFragments: vi.fn().mockResolvedValue({
                headerBytes: 'ab'.repeat(100), parameters: null, transactions: [{ signingMessage: 'cd'.repeat(50) }],
            }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any, false, 'mainnet');
        const bundle = await a.assemble(H, []);
        expect(bundle.parameters?.blockVersion).toBe(1);
    });

    it('below the first epoch start, takes the launch value: 4 on the public testnet', async () => {
        const H = 500;
        const blockId = 'aa'.repeat(32);
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockImplementation(async (h: number) => {
                if (h === H) return [blockId];
                throw new Error('unexpected-status');
            }),
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId, height: H })),
            getValidationFragments: vi.fn().mockResolvedValue({
                headerBytes: 'ab'.repeat(100), parameters: null, transactions: [{ signingMessage: 'cd'.repeat(50) }],
            }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any, false, 'testnet');
        const bundle = await a.assemble(H, []);
        expect(bundle.parameters?.blockVersion).toBe(4);
    });

    it('keeps the section block version on the bundle, as the parse context source', async () => {
        const blockId = 'aa'.repeat(32);
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue([blockId]),
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId, height: 2, headerVersion: 3, sectionBlockVersion: 3 })),
            getValidationFragments: vi.fn().mockResolvedValue({
                headerBytes: 'ab'.repeat(100), parameters: { maxBlockCost: 1_000_000 },
                transactions: [{ signingMessage: 'cd'.repeat(50) }],
            }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any);
        const bundle = await a.assemble(2, []);
        expect(bundle.sectionBlockVersion).toBe(3);
    });

    it('halts on a section whose version differs from its header (ergo 6.0.8 bsCorrespondsToHeader)', async () => {
        const blockId = 'aa'.repeat(32);
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue([blockId]),
            // header version 3, section marker 4 — refused by ergo 6.0.8
            getBlock: vi.fn().mockResolvedValue(mkBlock({ blockId, height: 2, headerVersion: 3, sectionBlockVersion: 4 })),
            getValidationFragments: vi.fn().mockResolvedValue({
                headerBytes: 'ab'.repeat(100), parameters: { maxBlockCost: 1_000_000 },
                transactions: [{ signingMessage: 'cd'.repeat(50) }],
            }),
        };
        const indexer = {
            getBoxBytes: vi.fn().mockImplementation(async (id: string) => new Uint8Array(64).fill(parseInt(id.slice(0, 2), 16))),
        };
        const oracle = {
            computeTxOracleCosts: vi.fn().mockReturnValue([{ oracleCost: 50n, oracleSucceeded: true, oracleError: null }]),
        };
        const a = new BundleAssembler(node as any, indexer as any, oracle as any);
        await expect(a.assemble(2, [])).rejects.toThrow(/section.*version.*header|header.*section.*version/i);
    });
});
