import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { compareProofs } from '../src/compare.ts';
import { hexToBytes } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CompareCase {
  label: string;
  a_hex: string;
  b_hex: string;
  a_better_than_b: boolean;
  b_better_than_a: boolean;
}

const fixtures: CompareCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/compare.json'), 'utf8'),
);

describe('compareProofs', () => {
  for (const c of fixtures) {
    test(`${c.label}: a better than b == ${c.a_better_than_b}`, () => {
      expect(compareProofs(hexToBytes(c.a_hex), hexToBytes(c.b_hex))).toBe(c.a_better_than_b);
    });
    test(`${c.label}: b better than a == ${c.b_better_than_a}`, () => {
      expect(compareProofs(hexToBytes(c.b_hex), hexToBytes(c.a_hex))).toBe(c.b_better_than_a);
    });
  }

  test('antisymmetry: a>b and b>a are never both true', () => {
    for (const c of fixtures) {
      const ab = compareProofs(hexToBytes(c.a_hex), hexToBytes(c.b_hex));
      const ba = compareProofs(hexToBytes(c.b_hex), hexToBytes(c.a_hex));
      expect(ab && ba, `${c.label}: both true violates antisymmetry`).toBe(false);
    }
  });

  test('reflexive: compareProofs(a, a) is always false', () => {
    for (const c of fixtures) {
      const aBytes = hexToBytes(c.a_hex);
      expect(compareProofs(aBytes, aBytes), `${c.label}: a compared to itself`).toBe(false);
    }
  });
});
