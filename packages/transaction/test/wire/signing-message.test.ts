import { describe, it, expect } from 'vitest';
import { parseTransaction } from '../../src/wire/transaction';
import { transactionId, signingMessage } from '../../src/wire/signing-message';
import { listFixtures, loadFixture, bytesToHex } from '../_helpers';

describe('signing message + txId', () => {
  for (const name of listFixtures()) {
    it(`computes the node-reported id for ${name}`, () => {
      const { bytes, meta } = loadFixture(name);
      const tx = parseTransaction(bytes);
      expect(signingMessage(tx).length).toBeGreaterThan(0);
      expect(bytesToHex(transactionId(tx))).toBe(meta.id);
    });
  }
});
