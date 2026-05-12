/**
 * Mutation tests: every single-byte flip of a valid proof must be rejected
 * by verifyProof.
 *
 * The contract isn't "every byte matters"; it's "the verifier never accepts a
 * proof it shouldn't." If a mutation at a given offset happens to be rejected
 * via parse failure, connection failure, height failure, or PoW failure —
 * any of those is a passing outcome.
 *
 * checkPoW: false because synthetic fixtures use trivial nonces. We're testing
 * structural rejection (parse / connections / heights), not PoW.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { verifyProof } from '../src/verifier.ts';
import { ProofVerificationError } from '../src/errors.ts';
import { hexToBytes } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ByteMutation {
  offset: number;
  mutated_bytes_hex: string;
  expected_to_fail: boolean;
}

interface ProofCase {
  label: string;
  byte_mutations?: ByteMutation[];
}

const fixtures: ProofCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/nipopow_proof.json'), 'utf8')
);

describe('verifyProof: every single-byte flip is rejected or in a non-critical region', () => {
  for (const c of fixtures) {
    for (const m of c.byte_mutations ?? []) {
      if (m.expected_to_fail) {
        // This offset is in a region the verifier actively validates.
        // The mutation MUST be rejected (any ProofVerificationError code counts).
        test(`${c.label} offset ${m.offset}: rejected (expected_to_fail)`, () => {
          try {
            verifyProof(hexToBytes(m.mutated_bytes_hex), { checkPoW: false });
            // If we reach here, the mutation was NOT rejected — coverage gap.
            throw new Error(
              `MUTATION PASSED verification at offset ${m.offset} in ${c.label} — ` +
              `this is a coverage gap in the verifier`
            );
          } catch (e) {
            // Any ProofVerificationError counts as correct rejection.
            // Different offsets land in different code paths:
            // parse-failed, invalid-connections, non-increasing-heights.
            expect(e).toBeInstanceOf(ProofVerificationError);
          }
        });
      } else {
        // This offset is in a non-verified region (e.g. interlinks[3+], autolykos nonce
        // of the last header). The Rust verifier confirmed it won't be caught.
        // We ASSERT that verifyProof SUCCEEDS for these — confirming the fixture is correct
        // and we understand the coverage boundary.
        test(`${c.label} offset ${m.offset}: passes (non-critical region, expected_to_fail=false)`, () => {
          // Should NOT throw — the mutation is in a region the verifier doesn't cover
          const result = verifyProof(hexToBytes(m.mutated_bytes_hex), { checkPoW: false });
          // Verify we got a valid result back
          expect(result.totalHeaders).toBeGreaterThan(0);
          expect(result.continuous).toBe(false);
        });
      }
    }
  }
});
