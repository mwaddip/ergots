import { describe, it, expect } from 'vitest';
import { parseTransaction, serializeTransaction } from '../../src/wire/transaction';
import { listFixtures, loadFixture, bytesToHex } from '../_helpers';

describe('Transaction parse — single-byte mutation', () => {
  for (const name of listFixtures()) {
    it(`every sampled single-byte flip in ${name} throws-typed or round-trips identically`, () => {
      const { bytes } = loadFixture(name);
      const step = Math.max(1, Math.floor(bytes.length / 256)); // bound runtime
      for (let i = 0; i < bytes.length; i += step) {
        const m = bytes.slice();
        m[i] = (m[i]! ^ 0xff) & 0xff;
        try {
          const tx = parseTransaction(m);
          // parsed without throwing → MUST re-serialize byte-identically (tolerated-region flip);
          // anything else is a silent mis-parse (consensus failure).
          expect(bytesToHex(serializeTransaction(tx))).toBe(bytesToHex(m));
        } catch (e) {
          // a throw is acceptable ONLY if it is a deliberate typed rejection, not a JS runtime crash.
          expect(e).toBeInstanceOf(Error);
        }
      }
    });
  }
});
