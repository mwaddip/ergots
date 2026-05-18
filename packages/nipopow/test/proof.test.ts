import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseProof } from '../src/proof.ts';
import { ProofParseError } from '../src/errors.ts';
import { hexToBytes } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ProofCase {
  label: string;
  m: number;
  k: number;
  chain_size: number;
  anchor: string | null;
  prefix_heights: number[];
  suffix_head_height: number;
  suffix_tail_heights: number[];
  bytes_hex: string;
  packed_leaves_per_popow_header: [string, string][][];
  interlinks_roots_per_popow_header: string[];
}

const fixtures: ProofCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/nipopow_proof.json'), 'utf8')
);

describe('NipopowProof parse', () => {
  for (const c of fixtures) {
    test(`${c.label}: m=${c.m}, k=${c.k} parses with expected heights`, () => {
      const proof = parseProof(hexToBytes(c.bytes_hex));
      expect(proof.m).toBe(c.m);
      expect(proof.k).toBe(c.k);
      expect(proof.prefix.map(p => p.header.height)).toEqual(c.prefix_heights);
      expect(proof.suffixHead.header.height).toBe(c.suffix_head_height);
      expect(proof.suffixTail.map(h => h.height)).toEqual(c.suffix_tail_heights);
    });
  }
});

describe('parseProof error cases', () => {
  test('empty input throws ProofParseError with empty-proof code', () => {
    try {
      parseProof(new Uint8Array(0));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('empty-proof');
    }
  });

  test('oversized input (>2 MB) throws ProofParseError with oversized code', () => {
    try {
      parseProof(new Uint8Array(2_000_001));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('oversized');
    }
  });

  test('truncated mid-parse throws ProofParseError', () => {
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    const truncated = original.slice(0, 10);
    expect(() => parseProof(truncated)).toThrow(ProofParseError);
  });

  test('prefix[0] size prefix lying smaller than actual element rejects with truncated', () => {
    // fixture[0] wire layout:
    //   byte 0:   m=2 (VLQ 0x02)
    //   byte 1:   k=2 (VLQ 0x02)
    //   byte 2:   prefix_length=8 (VLQ 0x08)
    //   bytes 3-4: prefix[0].size = 328 (VLQ 0xc8 0x02)
    // We replace the 2-byte VLQ for prefix[0].size with a 1-byte VLQ of value 1,
    // then skip the original second byte. This makes the declared size=1, causing the
    // sub-reader to exhaust after 1 byte and the inner PoPowHeader parse to fail.
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    const tampered = new Uint8Array(original.length - 1); // one byte shorter (removed 0x02 of two-byte VLQ)
    // Copy up to byte 3 (m, k, prefix_length)
    tampered.set(original.subarray(0, 3), 0);
    // Replace the 2-byte VLQ (0xc8 0x02) at offset 3 with 1-byte VLQ value=1 (0x01)
    tampered[3] = 0x01;
    // Copy the rest of the original (starting after the 2-byte VLQ at offset 5)
    tampered.set(original.subarray(5), 4);
    expect(() => parseProof(tampered)).toThrow(ProofParseError);
  });
});
