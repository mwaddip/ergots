import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parsePoPowHeader, serializePoPowHeader } from '../src/popow-header';
import { verifyBatchMerkleProof } from '../src/merkle';
import { ByteReader } from '@ergots/scorex';
import { ProofParseError } from '../src/errors';
import { hexToBytes, bytesToHex } from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PoPowHeaderCase {
  label: string;
  bytes_hex: string;
  header_id_hex: string;
  header_height: number;
  interlinks_hex: string[];
  interlinks_proof_bytes_hex: string;
  packed_leaves: [string, string][];
  interlinks_root_hex: string;
}
const fixtures: PoPowHeaderCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/popow_header.json'), 'utf8')
);

describe('PoPowHeader', () => {
  for (const c of fixtures) {
    test(`${c.label}: parse fields`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      const p = parsePoPowHeader(r);
      expect(p.header.height).toBe(c.header_height);
      expect(bytesToHex(p.header.id)).toBe(c.header_id_hex);
      expect(p.interlinks.length).toBe(c.interlinks_hex.length);
      for (let i = 0; i < p.interlinks.length; i++) {
        expect(bytesToHex(p.interlinks[i]!)).toBe(c.interlinks_hex[i]);
      }
    });

    test(`${c.label}: round-trip`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      const p = parsePoPowHeader(r);
      const re = serializePoPowHeader(p);
      expect(bytesToHex(re)).toBe(c.bytes_hex);
    });

    test(`${c.label}: interlinks proof verifies against interlinks Merkle root`, () => {
      // The proof verifies against the Merkle root of the packed interlinks extension KV pairs,
      // NOT against the header's extensionRoot field (which for synthetic fixtures is zero32).
      // This mirrors sigma-rust's check_interlinks_proof (nipopow_proof.rs:302-323).
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      const p = parsePoPowHeader(r);
      const leaves = c.packed_leaves.map(([k, v]) => ({
        key: hexToBytes(k),
        value: hexToBytes(v),
      }));
      const interlinksRoot = hexToBytes(c.interlinks_root_hex);
      const ok = verifyBatchMerkleProof(p.interlinksProof, leaves, interlinksRoot);
      expect(ok).toBe(true);
    });
  }
});

describe('PoPowHeader error cases', () => {
  test('truncated input mid-header throws ProofParseError', () => {
    // Take the first fixture and cut it to just 5 bytes (past the header_size VLQ
    // but well before enough data for a real header).
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    const truncated = original.slice(0, 5);
    expect(() => parsePoPowHeader(new ByteReader(truncated))).toThrow(ProofParseError);
  });

  test('oversized header_size declaration throws ProofParseError with code oversized', () => {
    // VLQ encoding of 10_001 = 0x2711:
    //   0x2711 = 0b_10_0111_0001_0001 → groups: 0b_0000001, 0b_0011100, 0b_0010001
    //   little-endian 7-bit groups of 10001:
    //   10001 = 0x2711 → 0x11 | 0x80 = 0x91 (low group + continuation),
    //                     0x4e = 78 (high group, no continuation)
    //   i.e., [0x91, 0x4e] is the VLQ for 10001 which exceeds MAX_HEADER_BYTES = 10_000
    const oversizeInput = new Uint8Array([0x91, 0x4e]);
    try {
      parsePoPowHeader(new ByteReader(oversizeInput));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('oversized');
    }
  });

  test('empty input throws ProofParseError', () => {
    expect(() => parsePoPowHeader(new ByteReader(new Uint8Array(0)))).toThrow(ProofParseError);
  });
});
