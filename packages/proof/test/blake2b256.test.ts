import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { blake2b256 } from '../src/crypto/blake2b256';
import { hexToBytes, bytesToHex } from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Blake2bCase { input_hex: string; output_hex: string; }
const fixtures: Blake2bCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/blake2b256.json'), 'utf8')
);

describe('blake2b256', () => {
  for (const c of fixtures) {
    test(`hash(${c.input_hex.length / 2} bytes) -> ${c.output_hex.slice(0, 16)}…`, () => {
      const result = blake2b256(hexToBytes(c.input_hex));
      expect(bytesToHex(result)).toBe(c.output_hex);
      expect(result.length).toBe(32);
    });
  }
});
