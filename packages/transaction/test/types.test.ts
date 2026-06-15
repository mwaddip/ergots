import { describe, it, expect } from 'vitest';
import type { ErgoLikeTransaction, Input, ErgoBoxCandidate } from '../src/types';

describe('types', () => {
  it('constructs an ErgoLikeTransaction value', () => {
    const tx: ErgoLikeTransaction = { inputs: [], dataInputs: [], outputCandidates: [] };
    expect(tx.inputs).toEqual([]);
  });

  it('Input and ErgoBoxCandidate types are exported', () => {
    const inputs: Input[] = [];
    const candidates: ErgoBoxCandidate[] = [];
    expect(inputs.length).toBe(0);
    expect(candidates.length).toBe(0);
  });
});
