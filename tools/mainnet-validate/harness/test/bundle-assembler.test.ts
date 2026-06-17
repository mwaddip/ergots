import { describe, it, expect, vi } from 'vitest';
import { BundleAssembler } from '../src/bundle-assembler.js';

describe('BundleAssembler', () => {
    it('assembles BlockBundle from node + indexer + oracle mocks', async () => {
        const mockHeaderRawJson = JSON.stringify({ id: 'aa'.repeat(32), height: 2, parentId: '00'.repeat(32), version: 1 });
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue(['aa'.repeat(32)]),
            getBlock: vi.fn().mockResolvedValue({
                header: { id: 'aa'.repeat(32), height: 2, parentId: '00'.repeat(32), version: 1, rawJson: mockHeaderRawJson },
                blockTransactions: {
                    transactions: [{
                        id: 'bb'.repeat(32),
                        inputs: [{ boxId: 'cc'.repeat(32), spendingProof: { proofBytes: '', extension: {} } }],
                        dataInputs: [],
                        outputs: [{ boxId: 'dd'.repeat(32), value: 100, ergoTree: '00', creationHeight: 2, transactionId: 'bb'.repeat(32), index: 0, assets: [], additionalRegisters: {} }],
                    }],
                },
                extension: { fields: [] },
            }),
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
        const rawJson = JSON.stringify({ id: blockId, height: H, parentId: '00'.repeat(32), version: 1 });
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockImplementation(async (h: number) =>
                h === H ? [blockId] : h === BOUNDARY ? [boundaryId] : []),
            getBlock: vi.fn().mockResolvedValue({
                header: { id: blockId, height: H, parentId: '00'.repeat(32), version: 1, rawJson },
                blockTransactions: {
                    transactions: [{
                        id: 'bb'.repeat(32),
                        inputs: [{ boxId: 'cc'.repeat(32), spendingProof: { proofBytes: '', extension: {} } }],
                        dataInputs: [],
                        outputs: [{ boxId: 'dd'.repeat(32), value: 100, ergoTree: '00', creationHeight: H, transactionId: 'bb'.repeat(32), index: 0, assets: [], additionalRegisters: {} }],
                    }],
                },
                extension: { fields: [] },
            }),
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
        const rawJson = JSON.stringify({ id: 'aa'.repeat(32), height: 2, parentId: '00'.repeat(32), version: 1 });
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue(['aa'.repeat(32)]),
            getBlock: vi.fn().mockResolvedValue({
                header: { id: 'aa'.repeat(32), height: 2, parentId: '00'.repeat(32), version: 1, rawJson },
                blockTransactions: {
                    transactions: [{
                        id: 'bb'.repeat(32),
                        inputs: [{ boxId: 'cc'.repeat(32), spendingProof: { proofBytes: '', extension: {} } }],
                        dataInputs: [],
                        outputs: [{ boxId: 'dd'.repeat(32), value: 100, ergoTree: '00', creationHeight: 2, transactionId: 'bb'.repeat(32), index: 0, assets: [], additionalRegisters: {} }],
                    }],
                },
                extension: { fields: [] },
            }),
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
        const rawJson = JSON.stringify({ id: 'aa'.repeat(32), height: 2, parentId: '00'.repeat(32), version: 1 });
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue(['aa'.repeat(32)]),
            getBlock: vi.fn().mockResolvedValue({
                header: { id: 'aa'.repeat(32), height: 2, parentId: '00'.repeat(32), version: 1, rawJson },
                blockTransactions: {
                    transactions: [{
                        id: 'bb'.repeat(32),
                        inputs: [{ boxId: 'cc'.repeat(32), spendingProof: { proofBytes: '', extension: {} } }],
                        dataInputs: [],
                        outputs: [{ boxId: 'dd'.repeat(32), value: 100, ergoTree: '00', creationHeight: 2, transactionId: 'bb'.repeat(32), index: 0, assets: [], additionalRegisters: {} }],
                    }],
                },
                extension: { fields: [] },
            }),
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
        const rawJson = JSON.stringify({ id: blockId, height: H, parentId: '00'.repeat(32), version: 1 });
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockImplementation(async (h: number) => {
                if (h === H) return [blockId];
                throw new Error('unexpected-status');  // boundary 0 not served
            }),
            getBlock: vi.fn().mockResolvedValue({
                header: { id: blockId, height: H, parentId: '00'.repeat(32), version: 1, rawJson },
                blockTransactions: {
                    transactions: [{
                        id: 'bb'.repeat(32),
                        inputs: [{ boxId: 'cc'.repeat(32), spendingProof: { proofBytes: '', extension: {} } }],
                        dataInputs: [],
                        outputs: [{ boxId: 'dd'.repeat(32), value: 100, ergoTree: '00', creationHeight: H, transactionId: 'bb'.repeat(32), index: 0, assets: [], additionalRegisters: {} }],
                    }],
                },
                extension: { fields: [] },
            }),
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
});
