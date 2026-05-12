import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { verifyProof } from '../src/verifier.ts';
import { ProofVerificationError } from '../src/errors.ts';
import { hexToBytes } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ConnectionMutation {
  label: string;
  mutated_bytes_hex: string;
  expected_valid: boolean;
}

interface ProofCase {
  label: string;
  bytes_hex: string;
  prefix_heights: number[];
  suffix_head_height: number;
  suffix_tail_heights: number[];
  connection_mutations?: ConnectionMutation[];
}

const fixtures: ProofCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/nipopow_proof.json'), 'utf8')
);

// ─────────────────────────────────────────────────────────────────────────────
// Positive cases: all 4 synthetic fixtures verify with checkPoW: false
// (Synthetic headers have trivial PoW nonces that don't satisfy the target;
// checkPoW: false bypasses that path entirely.)
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyProof: positive cases (checkPoW: false)', () => {
  for (const c of fixtures) {
    test(`${c.label}: verifies and returns correct counts/heights`, () => {
      const result = verifyProof(hexToBytes(c.bytes_hex), { checkPoW: false });

      const expectedTotal = c.prefix_heights.length + 1 + c.suffix_tail_heights.length;
      expect(result.totalHeaders).toBe(expectedTotal);

      const expectedTipHeight =
        c.suffix_tail_heights.length > 0
          ? c.suffix_tail_heights[c.suffix_tail_heights.length - 1]!
          : c.suffix_head_height;
      expect(result.suffixTipHeight).toBe(expectedTipHeight);

      expect(result.continuous).toBe(false);
      expect(result.headers).toHaveLength(expectedTotal);

      // Heights must be strictly increasing
      const heights = result.headers.map(h => h.height);
      for (let i = 1; i < heights.length; i++) {
        expect(heights[i]!).toBeGreaterThan(heights[i - 1]!);
      }

      // Last header height matches suffixTipHeight
      expect(result.headers[result.headers.length - 1]!.height).toBe(result.suffixTipHeight);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error-mode tests: malformed / empty / oversized bytes throw parse-failed
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyProof: error modes', () => {
  test('throws ProofVerificationError(parse-failed) on empty bytes', () => {
    try {
      verifyProof(new Uint8Array(0));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('parse-failed');
    }
  });

  test('throws ProofVerificationError(parse-failed) on oversized input', () => {
    try {
      verifyProof(new Uint8Array(2_000_001));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('parse-failed');
    }
  });

  test('throws ProofVerificationError(parse-failed) on truncated bytes', () => {
    // Take the first fixture and truncate to 10 bytes — definitely invalid
    const truncated = hexToBytes(fixtures[0]!.bytes_hex).slice(0, 10);
    try {
      verifyProof(truncated);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('parse-failed');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connection-mutation tests: every connection mutation is rejected with
// 'invalid-connections'
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyProof: connection mutations throw invalid-connections', () => {
  for (const c of fixtures) {
    for (const m of c.connection_mutations ?? []) {
      test(`${c.label} / ${m.label}: rejected with invalid-connections`, () => {
        try {
          verifyProof(hexToBytes(m.mutated_bytes_hex), { checkPoW: false });
          throw new Error('expected throw');
        } catch (e) {
          expect(e).toBeInstanceOf(ProofVerificationError);
          expect((e as ProofVerificationError).code).toBe('invalid-connections');
        }
      });
    }
  }
});
