import { describe, it, expect } from 'vitest';
import { ByteReader, ByteWriter } from '@ergots/scorex';
import { parseBoxCandidate, serializeBoxCandidate } from '../../src/wire/box-candidate';
import { hexToBytes, bytesToHex } from '../_helpers';

describe('ErgoBoxCandidate codec', () => {
  it('round-trips a minimal candidate (value, ergoTree, height, 1 token, 0 registers) against a token table', () => {
    const tokenId = hexToBytes('aa'.repeat(32));
    const table = [tokenId];                  // tx-wide digest table
    const idToIndex = new Map([['aa'.repeat(32), 0]]);
    const candidate = {
      value: 1000000n,
      ergoTreeBytes: hexToBytes('0008cd' + '02'.repeat(33)), // canonical P2PK ergoTree (valid)
      creationHeight: 100,
      tokens: [{ id: tokenId, amount: 5n }],
      registers: {},
    };
    const w = new ByteWriter();
    serializeBoxCandidate(candidate, idToIndex, w);
    const parsed = parseBoxCandidate(new ByteReader(w.toBytes()), table);
    const w2 = new ByteWriter();
    serializeBoxCandidate(parsed, idToIndex, w2);
    expect(bytesToHex(w2.toBytes())).toBe(bytesToHex(w.toBytes()));
    expect(parsed.value).toBe(1000000n);
    expect(parsed.tokens.length).toBe(1);
  });
});
