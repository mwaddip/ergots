import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { compareProofs } from '../src/compare.ts';
import { ProofParseError } from '../src/errors.ts';
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

  // facts/nipopow.md: parse failures MUST throw; do NOT silently return false.
  test('compareProofs throws ProofParseError on malformed a', () => {
    const valid = hexToBytes(fixtures[0]!.a_hex);
    const malformed = new Uint8Array([0xff, 0xff, 0xff]);
    expect(() => compareProofs(malformed, valid)).toThrow(ProofParseError);
  });

  test('compareProofs throws ProofParseError on malformed b', () => {
    const valid = hexToBytes(fixtures[0]!.a_hex);
    const malformed = new Uint8Array([0xff, 0xff, 0xff]);
    expect(() => compareProofs(valid, malformed)).toThrow(ProofParseError);
  });

  // Codex audit Finding #2: compareProofs must NOT score proofs with invalid
  // interlinks proofs as if they were valid. Mirrors sigma-rust is_better_than:
  // if b is invalid and a is valid → a wins; if both invalid → false.
  test('compareProofs returns true when b has mutated interlinks (a wins)', async () => {
    const { parseProof, serializeProof } = await import('../src/proof.ts');
    const aBytes = hexToBytes(fixtures[0]!.a_hex);
    const bBytes = hexToBytes(fixtures[0]!.b_hex);
    const parsedB = parseProof(bBytes);
    if (parsedB.suffixHead.interlinks.length < 2) {
      // Fixture has no non-genesis interlink to mutate; skip.
      return;
    }
    const mutated = new Uint8Array(parsedB.suffixHead.interlinks[1]!);
    mutated[0] = (mutated[0]! ^ 0xFF) & 0xFF;
    parsedB.suffixHead.interlinks[1] = mutated;
    const mutatedBBytes = serializeProof(parsedB);
    // a is valid; b has mutated interlinks → b is invalid. sigma-rust
    // is_better_than: a > b returns a.is_valid() = true.
    expect(compareProofs(aBytes, mutatedBBytes)).toBe(true);
  });

  test('compareProofs returns false when both proofs have mutated interlinks', async () => {
    const { parseProof, serializeProof } = await import('../src/proof.ts');
    const aBytes = hexToBytes(fixtures[0]!.a_hex);
    const bBytes = hexToBytes(fixtures[0]!.b_hex);
    const mutate = (b: Uint8Array): Uint8Array => {
      const p = parseProof(b);
      if (p.suffixHead.interlinks.length < 2) return b;
      const m = new Uint8Array(p.suffixHead.interlinks[1]!);
      m[0] = (m[0]! ^ 0xFF) & 0xFF;
      p.suffixHead.interlinks[1] = m;
      return serializeProof(p);
    };
    const mutatedA = mutate(aBytes);
    const mutatedB = mutate(bBytes);
    expect(compareProofs(mutatedA, mutatedB)).toBe(false);
  });
});
