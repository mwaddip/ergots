import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parsePoPowHeader, serializePoPowHeader } from '../src/popow-header';
import { ByteReader } from '../src/scorex/reader';
import { hexToBytes, bytesToHex } from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PoPowHeaderCase {
  label: string;
  bytes_hex: string;
  header_id_hex: string;
  header_height: number;
  interlinks_hex: string[];
  interlinks_proof_bytes_hex: string;
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
  }
});
