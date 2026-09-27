import { describe, it, expect } from 'vitest';
import type { ContextExtension } from '@ergots/ergoscript';
import { storageRentVerdict } from '../../src/validate/storage-rent';

// The rent gate (ergo v6.0.6 ErgoInterpreter.scala:73, :77). `null` = the branch does not apply
// and the input takes the script path. The SANTA storage-rent vectors cover the rest of the gate
// and every arm past it at the transaction level (storage-rent-conformance.test.ts).
const baseBox = (over: Partial<any> = {}) => ({
  value: 1_000_000n, ergoTreeBytes: new Uint8Array([0, 8, 0xd3]), creationHeight: 0,
  tokens: [], registers: {}, txId: new Uint8Array(32), index: 0, ...over,
});
const EMPTY_PROOF = new Uint8Array(0);
const var127: ContextExtension = {
  values: new Map([[127, { tpe: { tag: 'SShort' }, value: { kind: 'Short', value: 0 } }]]),
};

describe('storageRentVerdict — gate', () => {
  it('does not apply to a box younger than StoragePeriod, even with var 127 and an output', () => {
    const box = baseBox({ creationHeight: 1 });
    expect(storageRentVerdict(box, EMPTY_PROOF, var127, [baseBox()], 1_051_200, 1_250_000)).toBeNull();
  });
  it('does not apply without extension var 127, however old the box', () => {
    expect(storageRentVerdict(baseBox(), EMPTY_PROOF, { values: new Map() }, [baseBox()], 1_051_200, 1_250_000)).toBeNull();
  });
});
