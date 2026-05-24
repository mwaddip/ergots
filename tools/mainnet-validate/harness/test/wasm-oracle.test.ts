import { describe, it, expect, beforeAll } from 'vitest';
import { WasmCostOracle } from '../src/wasm-oracle.js';

describe('WasmCostOracle', () => {
    let oracle: WasmCostOracle;

    beforeAll(async () => {
        oracle = await WasmCostOracle.init();
    });

    it('exposes computeTxOracleCosts', () => {
        expect(typeof oracle.computeTxOracleCosts).toBe('function');
    });

    it('init() is idempotent', async () => {
        const second = await WasmCostOracle.init();
        expect(second).toBeDefined();
    });
});
