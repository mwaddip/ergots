import { describe, it, expect } from 'vitest';
import { ByteWriter, ByteReader } from '../src/index.ts';

describe('ByteWriter', () => {
  it('writes u8 + bytes', () => {
    const w = new ByteWriter();
    w.writeU8(0x42);
    w.writeBytes(new Uint8Array([1, 2, 3]));
    expect(w.toBytes()).toEqual(new Uint8Array([0x42, 1, 2, 3]));
    expect(w.length).toBe(4);
  });

  it('throws on writeU8 out of range', () => {
    const w = new ByteWriter();
    expect(() => w.writeU8(-1)).toThrow();
    expect(() => w.writeU8(0x100)).toThrow();
    expect(() => w.writeU8(1.5)).toThrow();
  });

  it('writeBytes is defensive (caller mutation does not affect output)', () => {
    const w = new ByteWriter();
    const src = new Uint8Array([1, 2, 3]);
    w.writeBytes(src);
    src[0] = 0xff;
    expect(w.toBytes()).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('round-trips VLQ unsigned (number API)', () => {
    for (const n of [0, 1, 127, 128, 16383, 16384, 0xffffffff]) {
      const w = new ByteWriter();
      w.writeVlqU(n);
      const r = new ByteReader(w.toBytes());
      expect(r.readVlqU()).toBe(n);
      expect(r.isExhausted).toBe(true);
    }
  });

  it('round-trips ZigZag signed (number API)', () => {
    for (const n of [0, 1, -1, 127, -128, 0x7fffffff, -0x80000000]) {
      const w = new ByteWriter();
      w.writeVlqS(n);
      const r = new ByteReader(w.toBytes());
      expect(r.readVlqS()).toBe(n);
      expect(r.isExhausted).toBe(true);
    }
  });

  it('round-trips VLQ unsigned BigInt (full u64 range)', () => {
    for (const n of [0n, 1n, 127n, 128n, 0xffffffffn, 0x100000000n, 0xffffffffffffffffn]) {
      const w = new ByteWriter();
      w.writeVlqBigInt(n);
      const r = new ByteReader(w.toBytes());
      expect(r.readVlqBigInt()).toBe(n);
      expect(r.isExhausted).toBe(true);
    }
  });

  it('round-trips ZigZag signed BigInt (full i64 range)', () => {
    const max = (1n << 63n) - 1n;
    const min = -(1n << 63n);
    for (const n of [0n, 1n, -1n, 127n, -128n, max, min]) {
      const w = new ByteWriter();
      w.writeVlqBigIntSigned(n);
      const r = new ByteReader(w.toBytes());
      expect(r.readVlqBigIntSigned()).toBe(n);
      expect(r.isExhausted).toBe(true);
    }
  });

  it('throws on writeVlqU negative', () => {
    const w = new ByteWriter();
    expect(() => w.writeVlqU(-1)).toThrow();
  });

  it('throws on writeVlqBigInt negative', () => {
    const w = new ByteWriter();
    expect(() => w.writeVlqBigInt(-1n)).toThrow();
  });

  it('matches known VLQ encodings byte-for-byte', () => {
    // Reader test covers: 0 -> [0x00]; 127 -> [0x7f]; 128 -> [0x80, 0x01]; 16383 -> [0xff, 0x7f]
    const cases: [number, number[]][] = [
      [0, [0x00]],
      [127, [0x7f]],
      [128, [0x80, 0x01]],
      [16383, [0xff, 0x7f]],
    ];
    for (const [n, expected] of cases) {
      const w = new ByteWriter();
      w.writeVlqU(n);
      expect(w.toBytes()).toEqual(new Uint8Array(expected));
    }
  });

  it('matches known ZigZag encodings byte-for-byte', () => {
    // ZigZag: 0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, 2 -> 4
    const cases: [number, number[]][] = [
      [0, [0]],
      [-1, [1]],
      [1, [2]],
      [-2, [3]],
      [2, [4]],
    ];
    for (const [n, expected] of cases) {
      const w = new ByteWriter();
      w.writeVlqS(n);
      expect(w.toBytes()).toEqual(new Uint8Array(expected));
    }
  });
});
