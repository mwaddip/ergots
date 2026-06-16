import { describe, it, expect } from 'vitest';
import { checkStructural, computeBoxId } from '../../src/validate/stateful';
import { TxValidationError } from '../../src/errors';
import { DEFAULT_PARAMETERS } from '../../src/params';

// A full ErgoBox. The id is COMPUTED (blake2b256 of serialized bytes), so inputs are
// built from the box via inputForBox(). Values clear dust (~box bytes * 360).
const TREE = new Uint8Array([0x08, 0xcd, ...new Array(33).fill(2)]); // P2PK-shaped raw tree bytes
const box = (value: bigint, creationHeight = 1, tokens: {id:Uint8Array;amount:bigint}[] = []) => ({
  value, ergoTreeBytes: TREE, creationHeight, tokens, registers: {}, txId: new Uint8Array(32), index: 0,
});
const candidate = (value: bigint, creationHeight = 1, tokens: {id:Uint8Array;amount:bigint}[] = []) =>
  ({ value, ergoTreeBytes: TREE, creationHeight, tokens, registers: {} });
const inputForBox = (b: any) => ({ boxId: computeBoxId(b), spendingProof: { proofBytes: new Uint8Array(), contextExtension: { values: new Map() } } });
function deps(inputBoxes: any[], version = 2, height = 10) {
  return { inputBoxes, dataInputBoxes: [], stateContext: { headers: [], preHeader: { height, version } as any, parameters: {} } };
}

describe('validateStateful structural checks', () => {
  it('accepts a conserved single-input tx', () => {
    const ib = [box(1_000_000n)];
    const tx = { inputs: [inputForBox(ib[0])], dataInputs: [], outputCandidates: [candidate(1_000_000n)] };
    expect(() => checkStructural(tx as any, deps(ib) as any, DEFAULT_PARAMETERS)).not.toThrow();
  });
  it('rejects value not conserved (Σin != Σout)', () => {
    const ib = [box(1_000_000n)];
    const tx = { inputs: [inputForBox(ib[0])], dataInputs: [], outputCandidates: [candidate(999_999n)] };
    try { checkStructural(tx as any, deps(ib) as any, DEFAULT_PARAMETERS); throw new Error('no throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('value-not-conserved'); }
  });
  it('rejects an input box id that does not match its provided box', () => {
    const ib = [box(1_000_000n)];
    const badInput = { boxId: new Uint8Array(32).fill(9), spendingProof: { proofBytes: new Uint8Array(), contextExtension: { values: new Map() } } };
    const tx = { inputs: [badInput], dataInputs: [], outputCandidates: [candidate(1_000_000n)] };
    try { checkStructural(tx as any, deps(ib) as any, DEFAULT_PARAMETERS); throw new Error('no throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('input-box-id-mismatch'); }
  });
  it('rejects a dust output (value < boxSize * minValuePerByte)', () => {
    const ib = [box(1n)];
    const tx = { inputs: [inputForBox(ib[0])], dataInputs: [], outputCandidates: [candidate(1n)] };
    try { checkStructural(tx as any, deps(ib) as any, DEFAULT_PARAMETERS); throw new Error('no throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('output-below-min-value'); }
  });
  it('rejects an output created in the future (creationHeight > preHeader.height)', () => {
    const ib = [box(1_000_000n)];
    const tx = { inputs: [inputForBox(ib[0])], dataInputs: [], outputCandidates: [candidate(1_000_000n, 999)] };
    try { checkStructural(tx as any, deps(ib, 2, 10) as any, DEFAULT_PARAMETERS); throw new Error('no throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('creation-height-in-future'); }
  });
  it('rejects a non-monotonic output height post-v3 (output height < max input height)', () => {
    const ib = [box(1_000_000n, 100)];
    const tx = { inputs: [inputForBox(ib[0])], dataInputs: [], outputCandidates: [candidate(1_000_000n, 50)] };
    try { checkStructural(tx as any, deps(ib, 3, 200) as any, DEFAULT_PARAMETERS); throw new Error('no throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('creation-height-below-max-input'); }
  });
  it('rejects creating tokens from thin air (out amount > in amount)', () => {
    const tid = new Uint8Array(32).fill(7);
    const ib = [box(1_000_000n, 1, [{ id: tid, amount: 5n }])];
    const tx = { inputs: [inputForBox(ib[0])], dataInputs: [], outputCandidates: [candidate(1_000_000n, 1, [{ id: tid, amount: 6n }])] };
    try { checkStructural(tx as any, deps(ib) as any, DEFAULT_PARAMETERS); throw new Error('no throw'); }
    catch (e) { expect((e as TxValidationError).code).toBe('token-not-conserved'); }
  });
});
