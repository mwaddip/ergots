import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseHeader, serializeHeader, deriveHeaderId } from '../src/header.ts';
import { readFixed } from '../src/digests.ts';
import { ByteReader } from '../src/reader.ts';
import { ReaderError } from '../src/errors.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface HeaderCase {
  label: string;
  bytes_hex: string;
  id_hex: string;
  height: number;
  n_bits: number;
  timestamp: number; // fixture JSON: always < 2^53; compared as BigInt(c.timestamp)
  parent_id_hex: string;
  extension_root_hex: string;
  version: number;
}

const fixtures: HeaderCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/header.json'), 'utf8')
);

describe('Header', () => {
  for (const c of fixtures) {
    test(`${c.label}: parse fields`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      const h = parseHeader(r);
      expect(h.height).toBe(c.height);
      expect(h.timestamp).toBe(BigInt(c.timestamp));
      expect(h.nBits).toBe(c.n_bits);
      expect(bytesToHex(h.parentId)).toBe(c.parent_id_hex);
      expect(bytesToHex(h.extensionRoot)).toBe(c.extension_root_hex);
      expect(h.version).toBe(c.version);
    });

    test(`${c.label}: round-trip`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      const h = parseHeader(r);
      const re = serializeHeader(h);
      expect(bytesToHex(re)).toBe(c.bytes_hex);
    });

    test(`${c.label}: ID derivation`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      const h = parseHeader(r);
      expect(bytesToHex(h.id)).toBe(c.id_hex); // parseHeader sets the slice-based id
      const id = deriveHeaderId(h);
      expect(bytesToHex(id)).toBe(c.id_hex);
    });
  }

  test('truncated input throws ReaderError', () => {
    // 50 bytes: enough for version + parentId + adProofsRoot, truncated before
    // transactionRoot (32 more bytes needed).
    const r = new ByteReader(new Uint8Array(50));
    try {
      parseHeader(r);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ReaderError);
      expect((e as ReaderError).code).toBe('truncated');
    }
  });

  test('readFixed passes position-limit-exceeded through unmodified (not re-coded to truncated)', () => {
    // The window entry check is a consensus gate (JVM CheckPositionLimit, rule
    // 1014); readFixed's truncation catch-all must not swallow its code.
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5]));
    r.readBytes(3); // position 3
    r.positionLimit = 2;
    try {
      readFixed(r, 2, 'windowed'); // 2 bytes remain, so only the window can throw
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ReaderError);
      expect((e as ReaderError).code).toBe('position-limit-exceeded');
    }
  });

  test('timestamp beyond 2^53 round-trips losslessly (u64 carried as bigint)', () => {
    // 4928911477310178288 > 2^53 — the SANTA Header_new_methods blessed value.
    // The pre-F2 carrier (number + MAX_SAFE_INTEGER parse guard) rejected this;
    // a u64 timestamp is consensus-valid (JVM carries Long, sigma-rust u64).
    const r = new ByteReader(hexToBytes(fixtures[0]!.bytes_hex));
    const h = parseHeader(r);
    h.timestamp = 4928911477310178288n;
    const re = serializeHeader(h);
    const h2 = parseHeader(new ByteReader(re));
    expect(h2.timestamp).toBe(4928911477310178288n);
    // Round-trip identity (the NIP-08 audit concern, now structurally lossless):
    expect(serializeHeader(h2)).toEqual(re);
  });
});
