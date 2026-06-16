import { describe, it, expect } from 'vitest';
import { buildHeadersArray, promoteCandidate } from '../../src/context';
import { hexToBytes } from '../_helpers';

describe('context helpers', () => {
  it('buildHeadersArray pads to 10 by repeating the oldest', () => {
    const mk = (h: number) => ({ height: h } as any);
    const out = buildHeadersArray([mk(5), mk(4), mk(3)]); // newest-first, 3 given
    expect(out.length).toBe(10);
    expect(out[0]!.height).toBe(5);
    expect(out[9]!.height).toBe(3); // padded with the oldest
  });
  it('buildHeadersArray takes only the newest 10 when more are given', () => {
    const arr = Array.from({ length: 14 }, (_, i) => ({ height: 100 - i } as any));
    const out = buildHeadersArray(arr);
    expect(out.length).toBe(10);
    expect(out[0]!.height).toBe(100);
    expect(out[9]!.height).toBe(91);
  });
  it('promoteCandidate assigns txId + index, preserving the body', () => {
    const cand = { value: 5n, ergoTreeBytes: hexToBytes('0008cd' + '02'.repeat(33)), creationHeight: 1, tokens: [], registers: {} };
    const txId = hexToBytes('ab'.repeat(32));
    const box = promoteCandidate(cand as any, txId, 2);
    expect(box.value).toBe(5n);
    expect(box.index).toBe(2);
    expect(Array.from(box.txId)).toEqual(Array.from(txId));
  });
});
