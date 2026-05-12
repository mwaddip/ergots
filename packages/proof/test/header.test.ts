import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseHeader, serializeHeader, deriveHeaderId } from '../src/header.ts';
import { ByteReader } from '../src/scorex/reader.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface HeaderCase {
  label: string;
  bytes_hex: string;
  id_hex: string;
  height: number;
  n_bits: number;
  timestamp: number;
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
      expect(h.timestamp).toBe(c.timestamp);
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
      const id = deriveHeaderId(h);
      expect(bytesToHex(id)).toBe(c.id_hex);
    });
  }
});
