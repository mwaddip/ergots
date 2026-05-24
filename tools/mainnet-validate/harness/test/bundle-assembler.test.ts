import { describe, it, expect, vi } from 'vitest';
import { BundleAssembler } from '../src/bundle-assembler.js';

describe('BundleAssembler', () => {
    it('assembles BlockBundle from node + indexer + oracle mocks', async () => {
        const node = {
            getHeaderIdsAtHeight: vi.fn().mockResolvedValue(['aa'.repeat(32)]),
            getBlock: vi.fn().mockResolvedValue({
                header: { id: 'aa'.repeat(32), height: 2, parentId: '00'.repeat(32), version: 1 },
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
});
