import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { compareProofs } from '../src/compare.ts';
import { ProofParseError } from '../src/errors.ts';
import { parseProof } from '../src/proof.ts';
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

  // ───────────────────────────────────────────────────────────────────────────
  // NIP-03 regression — compareProofs must fail fast on m=0 (no infinite loop)
  //
  // Pre-fix bestArg's `args.length >= m` check passed for every iteration when
  // m=0, causing the loop to never terminate (audit repro: comparison script
  // timed out after 5 s). Post-fix parseProof rejects m=0 with 'invalid-m',
  // so compareProofs (which calls parseProof) surfaces the failure before
  // bestArg is ever reached.
  // ───────────────────────────────────────────────────────────────────────────
  test('NIP-03: compareProofs fails fast on m=0 (does not hang)', () => {
    const validA = hexToBytes(fixtures[0]!.a_hex);
    const validB = hexToBytes(fixtures[0]!.b_hex);
    // First byte of a NipopowProof is the VLQ-u32 m field. Setting it to 0 makes m=0.
    // The fixture's original m is small enough to be a single VLQ byte (< 0x80),
    // so byte 0 is the entire m field.
    const mutatedA = new Uint8Array(validA);
    mutatedA[0] = 0;
    try {
      compareProofs(mutatedA, validB);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('invalid-m');
    }
  });

  test('NIP-03: compareProofs fails fast on m=0 in second argument', () => {
    const validA = hexToBytes(fixtures[0]!.a_hex);
    const validB = hexToBytes(fixtures[0]!.b_hex);
    const mutatedB = new Uint8Array(validB);
    mutatedB[0] = 0;
    try {
      compareProofs(validA, mutatedB);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('invalid-m');
    }
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

describe('continuous gate in compareProofs isValid (JVM NipopowProof.isValid conjunction)', () => {
  // Fixture: compare.json's "different-chains-chain20-vs-chain64" (a_hex is chain-20 with suffixHead 19).
  // Chain-20-m2-k2-tip: suffixHead 19, present heights {1,3,5,8,9,10,12,14,19,20}.
  // At epochLength 8 (u=8): needed gated (0,19) = [8,16]; 16 is ABSENT.
  const entry = fixtures.find(f => f.label === 'different-chains-chain20-vs-chain64')!;
  const chain20Bytes = () => hexToBytes(entry.a_hex);
  const continuousBytes = () => {
    const b = new Uint8Array(chain20Bytes());
    b[b.length - 1] = 0x01;
    return b;
  };

  test('chain-20 fixture pinning: a_hex side is suffixHead height 19', () => {
    expect(parseProof(chain20Bytes()).suffixHead.header.height).toBe(19);
  });

  test('continuous proof missing difficulty headers is not comparable: valid non-continuous wins', () => {
    expect(compareProofs(chain20Bytes(), continuousBytes(), { epochLength: 8 })).toBe(true);
    expect(compareProofs(continuousBytes(), chain20Bytes(), { epochLength: 8 })).toBe(false);
  });

  test('same pair at mainnet defaults: both valid (vacuous check on tiny chain), equal chains -> not better either way', () => {
    expect(compareProofs(chain20Bytes(), continuousBytes())).toBe(false);
    expect(compareProofs(continuousBytes(), chain20Bytes())).toBe(false);
  });

  test('both continuous-invalid: neither is better', () => {
    expect(compareProofs(continuousBytes(), continuousBytes(), { epochLength: 8 })).toBe(false);
  });

  test('bad opts throw RangeError', () => {
    expect(() => compareProofs(chain20Bytes(), chain20Bytes(), { epochLength: 0 })).toThrow(RangeError);
  });
});
