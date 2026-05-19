import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { decodeCompactBits } from '../src/nbits';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface NBitsCase { n_bits: number; target_decimal: string; }
const fixtures: NBitsCase[] = JSON.parse(
  readFileSync(resolve(__dirname, '../../nipopow/test/fixtures/nbits.json'), 'utf8')
);

describe('decodeCompactBits', () => {
  for (const c of fixtures) {
    test(`nBits=0x${c.n_bits.toString(16).padStart(8, '0')} -> ${c.target_decimal}`, () => {
      expect(decodeCompactBits(c.n_bits).toString()).toBe(c.target_decimal);
    });
  }
});
