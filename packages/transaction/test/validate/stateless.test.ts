import { describe, it, expect } from 'vitest';
import { validateStateless } from '../../src/validate/stateless';
import { TxValidationError } from '../../src/errors';
import { parseTransaction } from '../../src';
import { listFixtures, loadFixture } from '../_helpers';

const out = (value: bigint) => ({ value, ergoTreeBytes: new Uint8Array([0,8]), creationHeight: 1, tokens: [], registers: {} });
const inp = (id: number) => ({ boxId: new Uint8Array(32).fill(id), spendingProof: { proofBytes: new Uint8Array(), contextExtension: { values: {} } } });

describe('validateStateless', () => {
  it('accepts every phase-1 wire fixture (real txs are stateless-valid)', () => {
    for (const name of listFixtures()) {
      expect(() => validateStateless(parseTransaction(loadFixture(name).bytes))).not.toThrow();
    }
  });
  it('rejects zero outputs', () => {
    const tx = { inputs: [inp(1)], dataInputs: [], outputCandidates: [] };
    try { validateStateless(tx as any); throw new Error('did not throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('outputs-empty'); }
  });
  it('rejects zero inputs', () => {
    const tx = { inputs: [], dataInputs: [], outputCandidates: [out(1n)] };
    try { validateStateless(tx as any); throw new Error('did not throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('inputs-empty'); }
  });
  it('rejects a duplicate input box id', () => {
    const tx = { inputs: [inp(1), inp(1)], dataInputs: [], outputCandidates: [out(1n)] };
    try { validateStateless(tx as any); throw new Error('did not throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('duplicate-input'); }
  });
  it('rejects an output value sum that overflows i64', () => {
    const big = 1n << 62n; // two of these sum to 2^63 > i64::MAX
    const tx = { inputs: [inp(1)], dataInputs: [], outputCandidates: [out(big), out(big)] };
    try { validateStateless(tx as any); throw new Error('did not throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('output-sum-overflow'); }
  });
});
