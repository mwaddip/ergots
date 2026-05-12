import { describe, test, expect } from 'vitest';
import { ByteWriter } from '../src/scorex/writer';

describe('ByteWriter', () => {
  test('empty writer produces empty Uint8Array', () => {
    expect(new ByteWriter().toBytes()).toEqual(new Uint8Array([]));
  });

  test('writeU8 appends one byte', () => {
    const w = new ByteWriter();
    w.writeU8(0x42);
    expect(w.toBytes()).toEqual(new Uint8Array([0x42]));
  });

  test('writeU8 rejects out-of-range', () => {
    const w = new ByteWriter();
    expect(() => w.writeU8(256)).toThrow();
    expect(() => w.writeU8(-1)).toThrow();
  });

  test('writeBytes appends a slice', () => {
    const w = new ByteWriter();
    w.writeBytes(new Uint8Array([1, 2, 3]));
    w.writeBytes(new Uint8Array([4, 5]));
    expect(w.toBytes()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  test('length reports current size', () => {
    const w = new ByteWriter();
    w.writeBytes(new Uint8Array([1, 2, 3]));
    expect(w.length).toBe(3);
  });
});
