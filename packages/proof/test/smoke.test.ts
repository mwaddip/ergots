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

  test('@noble/hashes blake2b resolves and exports a function', async () => {
    // v2.x ships ./blake2.js (not ./blake2b); Task 6 must import from here
    const { blake2b } = await import('@noble/hashes/blake2.js');
    expect(typeof blake2b).toBe('function');
  });
});
