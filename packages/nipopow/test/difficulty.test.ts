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
