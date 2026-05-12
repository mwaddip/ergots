import { describe, test, expect } from 'vitest';

describe('package smoke', () => {
  test('vitest runs', () => {
    expect(1 + 1).toBe(2);
  });

  test('Uint8Array is available without DOM', () => {
    const arr = new Uint8Array([1, 2, 3]);
    expect(arr.length).toBe(3);
  });

  test('bigint arithmetic works', () => {
    const x = (1n << 64n) - 1n;
    expect(x.toString(16)).toBe('ffffffffffffffff');
  });
});
