import { describe, it, expect } from 'vitest';
import { maxLevelOf, ORDER } from '../src/level.ts';
import { headerWithHit } from './helpers.ts';

describe('maxLevelOf (shared level.ts)', () => {
  const REQUIRED = ORDER / 4096n;

  it('truncates toward zero at the level-0 boundary (JVM Double.toInt), not floor', () => {
    // hit = 1.5 × required → exact level = log2(2/3) ≈ −0.585
    // JVM (−0.585).toInt = 0; Math.floor would give −1.
    expect(maxLevelOf(headerWithHit(5, REQUIRED + REQUIRED / 2n))).toBe(0);
  });

  it('positive levels unchanged: hit = required/9 → level 3', () => {
    // ratio 9 → log2 ≈ 3.17 → trunc 3 (same as floor)
    expect(maxLevelOf(headerWithHit(5, REQUIRED / 9n))).toBe(3);
  });

  it('genesis is MAX_SAFE_INTEGER', () => {
    expect(maxLevelOf(headerWithHit(1, REQUIRED))).toBe(Number.MAX_SAFE_INTEGER);
  });
});
