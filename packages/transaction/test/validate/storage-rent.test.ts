import { describe, it, expect } from 'vitest';
import { checkStorageRent } from '../../src/validate/storage-rent';

const baseBox = (over: Partial<any> = {}) => ({
  value: 1_000_000n, ergoTreeBytes: new Uint8Array([0,8]), creationHeight: 0,
  tokens: [], registers: {}, txId: new Uint8Array(32), index: 0, ...over,
});

describe('checkStorageRent', () => {
  it('false when the box is not old enough (height - creationHeight < STORAGE_PERIOD)', () => {
    const box = baseBox({ creationHeight: 100 });
    expect(checkStorageRent(box, 100_000, { values: new Map() }, [], 0, 1_250_000)).toBe(false);
  });
  it('false when no recreation index (extension var 127) is present even if old enough', () => {
    const box = baseBox({ creationHeight: 0 });
    expect(checkStorageRent(box, 1_051_200, { values: new Map() }, [], 0, 1_250_000)).toBe(false);
  });
});
