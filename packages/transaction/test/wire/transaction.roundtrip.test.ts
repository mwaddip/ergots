import { describe, it, expect } from 'vitest';
import { parseTransaction, serializeTransaction } from '../../src/wire/transaction';
import type { ErgoLikeTransaction } from '../../src/types';
import { hexToBytes, listFixtures, loadFixture, bytesToHex } from '../_helpers';

describe('Transaction round-trip vs testnet fixtures', () => {
  for (const name of listFixtures()) {
    it(`round-trips ${name} byte-identically`, () => {
      const { bytes } = loadFixture(name);
      const tx = parseTransaction(bytes);
      const out = serializeTransaction(tx);
      expect(bytesToHex(out)).toBe(bytesToHex(bytes));
    });
  }
});

describe('Transaction synthetic data-input round-trip', () => {
  // No testnet fixture in the corpus carries data-inputs, so the data-input
  // section of the envelope is exercised here with a self-consistency
  // round-trip: build a tx in memory, serialize → parse → re-serialize, and
  // assert the two serializations are byte-identical (the codec is its own
  // oracle — there is no authoritative fixture for this shape).
  it('round-trips a tx with 2 data-inputs, 1 input, 1 output candidate', () => {
    const tokenId = hexToBytes('aa'.repeat(32));
    const tx: ErgoLikeTransaction = {
      inputs: [
        {
          boxId: hexToBytes('11'.repeat(32)),
          spendingProof: { proofBytes: new Uint8Array(0), contextExtension: { values: {} } },
        },
      ],
      dataInputs: [
        { boxId: hexToBytes('22'.repeat(32)) },
        { boxId: hexToBytes('33'.repeat(32)) },
      ],
      outputCandidates: [
        {
          value: 1_000_000n,
          // canonical P2PK ergoTree (valid, self-delimiting via header)
          ergoTreeBytes: hexToBytes('0008cd' + '02'.repeat(33)),
          creationHeight: 100,
          tokens: [{ id: tokenId, amount: 5n }],
          registers: {},
        },
      ],
    };

    const bytes = serializeTransaction(tx);
    const reparsed = parseTransaction(bytes);
    const out = serializeTransaction(reparsed);
    expect(bytesToHex(out)).toBe(bytesToHex(bytes));

    // structural sanity: the data-inputs survived the round-trip
    expect(reparsed.dataInputs.length).toBe(2);
    expect(bytesToHex(reparsed.dataInputs[0]!.boxId)).toBe('22'.repeat(32));
    expect(bytesToHex(reparsed.dataInputs[1]!.boxId)).toBe('33'.repeat(32));
  });
});
