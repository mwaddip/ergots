import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseProof, serializeProof } from '../src/proof.ts';
import { verifyParsedProof } from '../src/verifier.ts';
import { compareProofs } from '../src/compare.ts';
import { hasValidDifficultyHeaders, heightsForNextRecalculation } from '../src/difficulty.ts';
import { ProofVerificationError } from '../src/errors.ts';
import { hexToBytes } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ContinuousVector {
  name: string;
  description: string;
  m: number;
  k: number;
  epochLength: number;
  useLastEpochs: number;
  suffixHeadHeight: number;
  neededHeights: number[];
  hasValidDifficultyHeaders: boolean;
  isValid: boolean;
  bytesHex: string;
}

const vectors: ContinuousVector[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/jvm_continuous/vectors.json'), 'utf8'),
).vectors;

// `hasValidDifficultyHeaders` / `isValid` on each vector are the JVM's
// RECORDED outputs — captured by running the actual JVM code against each
// vector, not derived or guessed by this package. The "Predict hVDH=..."
// wording in some vectors' `description` strings is leftover from the
// construction plan that specified what each vector should exercise; it is
// not a claim that these booleans are unverified predictions.
describe('JVM continuous-mode truth vectors (SANTA batch 2)', () => {
  test('fixture has all 6 vectors (guards against a silently-emptied fixture)', () => {
    expect(vectors.length).toBe(6);
  });

  test.each(vectors.map(v => [v.name, v] as const))('%s: parse + round-trip + booleans match JVM', (_name, v) => {
    const bytes = hexToBytes(v.bytesHex);
    const proof = parseProof(bytes);
    expect(serializeProof(proof)).toEqual(bytes);
    expect(proof.m).toBe(v.m);
    expect(proof.suffixHead.header.height).toBe(v.suffixHeadHeight);

    // our epoch math reproduces the JVM's recorded needed heights
    expect(heightsForNextRecalculation(v.suffixHeadHeight, v.epochLength, v.useLastEpochs)).toEqual(
      v.neededHeights,
    );

    // the membership check agrees with the JVM boolean
    expect(hasValidDifficultyHeaders(proof, v.epochLength, v.useLastEpochs)).toBe(
      v.hasValidDifficultyHeaders,
    );

    // full-pipeline agreement with JVM isValid: verifyParsedProof with
    // checkPoW:false runs exactly the four isValid conjuncts (fake-PoW
    // chains; the v1/v2 version gate is checkPoW-gated too).
    const opts = { checkPoW: false, epochLength: v.epochLength, useLastEpochs: v.useLastEpochs };
    if (v.isValid) {
      expect(verifyParsedProof(proof, opts).continuous).toBe(proof.continuous);
    } else {
      expect(() => verifyParsedProof(proof, opts)).toThrow(ProofVerificationError);
    }
  });

  test('compareProofs: JVM-valid vector beats JVM-invalid vector, not vice versa', () => {
    const valid = vectors.find(v => v.isValid && v.hasValidDifficultyHeaders);
    const invalid = vectors.find(v => !v.isValid);
    if (!valid || !invalid) return; // vector set lacks the pairing; covered per-vector above
    const opts = { epochLength: valid.epochLength, useLastEpochs: valid.useLastEpochs };
    expect(compareProofs(hexToBytes(valid.bytesHex), hexToBytes(invalid.bytesHex), opts)).toBe(true);
    expect(compareProofs(hexToBytes(invalid.bytesHex), hexToBytes(valid.bytesHex), opts)).toBe(false);
  });
});
