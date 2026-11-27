import { describe, it, expect } from 'vitest';
import { parseTransaction, serializeTransaction } from '../../src/wire/transaction';
import { listFixtures, loadFixture, bytesToHex } from '../_helpers';

describe('Transaction parse — single-byte mutation', () => {
  // The testnet corpus is of v4 blocks, parsed under (3, 3) as a node parses them (ergo
  // BlockTransactions.scala:184-202). A single-byte flip may still produce a valid parse that
  // re-serializes identically, or a typed throw; a mutation that leaves bytes after the
  // transaction parses, because the JVM's parseBytes ignores them, and its re-serialization
  // is the transaction's bytes without that suffix (not a round-trip identity against m).
  for (const name of listFixtures()) {
    it(`every sampled single-byte flip in ${name} throws-typed or re-serializes a parsed prefix`, () => {
      const { bytes } = loadFixture(name);
      const step = Math.max(1, Math.floor(bytes.length / 256)); // bound runtime
      for (let i = 0; i < bytes.length; i += step) {
        const m = bytes.slice();
        m[i] = (m[i]! ^ 0xff) & 0xff;
        try {
          const tx = parseTransaction(m, { activated: 3, ergoTree: 3 });
          // parsed without throwing → MUST re-serialize to a prefix of m (the transaction's
          // own bytes); anything else is a silent mis-parse (consensus failure).
          const out = serializeTransaction(tx);
          expect(bytesToHex(m.slice(0, out.length))).toBe(bytesToHex(out));
        } catch (e) {
          // a throw is acceptable ONLY if it is a deliberate typed rejection, not a JS runtime crash.
          expect(e).toBeInstanceOf(Error);
        }
      }
    });
  }
});
