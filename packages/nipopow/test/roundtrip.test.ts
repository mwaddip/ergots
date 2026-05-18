import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseProof, serializeProof } from '../src/proof.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ProofCase {
  label: string;
  bytes_hex: string;
}

const fixtures: ProofCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/nipopow_proof.json'), 'utf8')
);

describe('NipopowProof round-trip', () => {
  for (const c of fixtures) {
    test(`${c.label}: parse → serialize → byte-equal`, () => {
      const proof = parseProof(hexToBytes(c.bytes_hex));
      const re = serializeProof(proof);
      expect(bytesToHex(re)).toBe(c.bytes_hex);
    });
  }
});
