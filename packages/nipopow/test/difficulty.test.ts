import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  nextRecalculationHeight,
  previousHeightsRequiredForRecalculation,
  heightsForNextRecalculation,
  resolveDifficultyParams,
  EPOCH_LENGTH_MAINNET,
  USE_LAST_EPOCHS_MAINNET,
} from '../src/difficulty.ts';
import { buildSyntheticProof } from './helpers.ts';
import { hasValidDifficultyHeaders } from '../src/difficulty.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TruthRow {
  epochLength: number;
  useLastEpochs: number;
  height: number;
  next: number;
  prev: number[];
  forNext: number[];
}

const truthTable: { rows: TruthRow[] } = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/jvm_difficulty/epoch-math-truth-table.json'), 'utf8'),
);

describe('epoch math vs JVM DifficultyAdjustment truth table (SANTA batch 1)', () => {
  test('fixture has the expected 49 rows across three (e,u) pairs', () => {
    expect(truthTable.rows.length).toBe(49);
    const pairs = new Set(truthTable.rows.map(r => `${r.epochLength}/${r.useLastEpochs}`));
    expect(pairs).toEqual(new Set(['128/8', '1024/8', '1/8']));
  });

  test('every row matches all three functions', () => {
    for (const row of truthTable.rows) {
      const { epochLength: e, useLastEpochs: u, height: h } = row;
      expect(nextRecalculationHeight(h, e), `next(${h}, ${e})`).toBe(row.next);
      expect(
        previousHeightsRequiredForRecalculation(h, e, u),
        `prev(${h}, ${e}, ${u})`,
      ).toEqual(row.prev);
      expect(heightsForNextRecalculation(h, e, u), `forNext(${h}, ${e}, ${u})`).toEqual(row.forNext);
    }
  });
});

describe('resolveDifficultyParams', () => {
  test('defaults are the mainnet constants', () => {
    expect(resolveDifficultyParams()).toEqual({ epochLength: 128, useLastEpochs: 8 });
    expect(resolveDifficultyParams({})).toEqual({ epochLength: 128, useLastEpochs: 8 });
    expect(EPOCH_LENGTH_MAINNET).toBe(128);
    expect(USE_LAST_EPOCHS_MAINNET).toBe(8);
  });

  test('partial overrides keep the other default', () => {
    expect(resolveDifficultyParams({ epochLength: 1024 })).toEqual({ epochLength: 1024, useLastEpochs: 8 });
    expect(resolveDifficultyParams({ useLastEpochs: 4 })).toEqual({ epochLength: 128, useLastEpochs: 4 });
  });

  test.each([
    { epochLength: 0 },
    { epochLength: -128 },
    { epochLength: 1.5 },
    { epochLength: Number.NaN },
    { useLastEpochs: 1 },
    { useLastEpochs: 0 },
    { useLastEpochs: 2.5 },
    { epochLength: 2 ** 20, useLastEpochs: 2 ** 15 }, // product 2^35 > 2^31
  ])('rejects %j with RangeError', (opts) => {
    expect(() => resolveDifficultyParams(opts)).toThrow(RangeError);
  });

  test('accepts exotic-but-valid overrides (epochLength 1 is legal, JVM requires only > 0)', () => {
    expect(resolveDifficultyParams({ epochLength: 1, useLastEpochs: 8 })).toEqual({
      epochLength: 1,
      useLastEpochs: 8,
    });
  });
});

describe('hasValidDifficultyHeaders (e=16, u=8 unless noted)', () => {
  // suffixHead 100, e=16: next = 113, prevHeights(113) = [0,16,...,112];
  // gated to (0, 100) -> [16, 32, 48, 64, 80, 96].
  const NEEDED_100 = [16, 32, 48, 64, 80, 96];

  test('continuous=false is vacuously true (headers absent)', () => {
    const proof = buildSyntheticProof({ prefixHeights: [1, 50], suffixHeadHeight: 100, m: 2, k: 1 });
    expect(proof.continuous).toBe(false);
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(true);
  });

  test('continuous=true with every needed height present is true', () => {
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1, ...NEEDED_100], suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(true);
  });

  test('interleaved extra prefix heights do not break the non-resetting cursor', () => {
    const heights = [1, 10, 16, 20, 32, 40, 48, 60, 64, 77, 80, 90, 96, 99];
    const proof = {
      ...buildSyntheticProof({ prefixHeights: heights, suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(true);
  });

  test('one missing needed height (48) is false', () => {
    const heights = [1, 16, 32, 64, 80, 96];
    const proof = {
      ...buildSyntheticProof({ prefixHeights: heights, suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(false);
  });

  test('suffixTail entries participate in the flat scan without corrupting the cursor', () => {
    // suffixHead 95: next = 97, prevHeights(97) = [0,16,...,96]; gated (0,95) -> [16,...,80].
    // All needed heights (16..80) are < suffixHead, so none can come from suffixTail (all > suffixHead).
    // The tail entry (96) participates in chainHeights but never satisfies a needed height.
    // Test verifies the non-resetting cursor still finds all needed heights from the prefix.
    // Heights strictly increasing: prefix has 16..64, tail has 96; 80 missing -> false.
    const missing80 = {
      ...buildSyntheticProof({
        prefixHeights: [1, 16, 32, 48, 64],
        suffixHeadHeight: 95,
        suffixTailHeights: [96],
        m: 2,
        k: 2,
      }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(missing80, 16, 8)).toBe(false);
    const present = {
      ...buildSyntheticProof({
        prefixHeights: [1, 16, 32, 48, 64, 80],
        suffixHeadHeight: 95,
        suffixTailHeights: [96],
        m: 2,
        k: 2,
      }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(present, 16, 8)).toBe(true);
  });

  test('boundary suffixHead % e === 0: needed excludes the suffixHead height itself', () => {
    // suffixHead 48: next = 49, prevHeights(49) = [0, 16, 32, 48]; gated (0, 48) -> [16, 32].
    const ok = {
      ...buildSyntheticProof({ prefixHeights: [1, 16, 32], suffixHeadHeight: 48, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(ok, 16, 8)).toBe(true);
    const missing32 = {
      ...buildSyntheticProof({ prefixHeights: [1, 16], suffixHeadHeight: 48, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(missing32, 16, 8)).toBe(false);
  });

  test('tiny suffixHead: gated needed set empty -> vacuously true with flag set', () => {
    // suffixHead 16: next = 17, prevHeights(17) = [0, 16]; gated (0, 16) -> [].
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1], suffixHeadHeight: 16, m: 1, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(true);
  });

  test('mainnet defaults on a small chain: vacuously true (matches fixture[0] shape)', () => {
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1, 5], suffixHeadHeight: 19, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 128, 8)).toBe(true);
  });
});
