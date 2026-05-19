import { describe, expect, test } from 'vitest';
import { ByteReader, ByteWriter, ReaderError } from '../src/index.ts';
import { encodeVlqU } from '../src/vlq.ts';

describe('readBool / writeBool', () => {
  test('writeBool(true) emits 0x01', () => {
    const w = new ByteWriter();
    w.writeBool(true);
    expect(w.toBytes()).toEqual(new Uint8Array([0x01]));
  });

  test('writeBool(false) emits 0x00', () => {
    const w = new ByteWriter();
    w.writeBool(false);
    expect(w.toBytes()).toEqual(new Uint8Array([0x00]));
  });

  test('readBool round-trips both values', () => {
    for (const v of [true, false]) {
      const w = new ByteWriter();
      w.writeBool(v);
      const r = new ByteReader(w.toBytes());
      expect(r.readBool()).toBe(v);
      expect(r.isExhausted).toBe(true);
    }
  });

  test('readBool rejects non-{0,1} byte', () => {
    const r = new ByteReader(new Uint8Array([0x02]));
    expect(() => r.readBool()).toThrow();
  });
});

describe('readOption / writeOption', () => {
  test('writeOption(null) emits 0x00', () => {
    const w = new ByteWriter();
    w.writeOption<number>(null, (w, v) => w.writeU8(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0x00]));
  });

  test('writeOption(value, ser) emits 0x01 + ser bytes', () => {
    const w = new ByteWriter();
    w.writeOption<number>(42, (w, v) => w.writeU8(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0x01, 42]));
  });

  test('readOption round-trips null and value', () => {
    for (const v of [null, 7] as Array<number | null>) {
      const w = new ByteWriter();
      w.writeOption<number>(v, (w, v) => w.writeU8(v));
      const r = new ByteReader(w.toBytes());
      const decoded = r.readOption<number>((r) => r.readU8());
      expect(decoded).toEqual(v);
      expect(r.isExhausted).toBe(true);
    }
  });

  test('readOption rejects malformed tag byte', () => {
    const r = new ByteReader(new Uint8Array([0x02, 0x00]));
    expect(() => r.readOption<number>((r) => r.readU8())).toThrow();
  });
});

describe('readArray / writeArray', () => {
  test('writeArray([]) emits single 0x00 VLQ length', () => {
    const w = new ByteWriter();
    w.writeArray<number>([], (w, v) => w.writeU8(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0x00]));
  });

  test('writeArray([1,2,3]) emits VLQ length + items', () => {
    const w = new ByteWriter();
    w.writeArray<number>([1, 2, 3], (w, v) => w.writeU8(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0x03, 1, 2, 3]));
  });

  test('readArray round-trips empty, small, and multi-byte-length arrays', () => {
    for (const arr of [
      [] as number[],
      [9] as number[],
      Array.from({ length: 256 }, (_, i) => i % 200), // multi-byte VLQ length
    ]) {
      const w = new ByteWriter();
      w.writeArray<number>(arr, (w, v) => w.writeU8(v));
      const r = new ByteReader(w.toBytes());
      const decoded = r.readArray<number>((r) => r.readU8());
      expect(decoded).toEqual(arr);
      expect(r.isExhausted).toBe(true);
    }
  });

  test('readArray throws on truncated element stream', () => {
    const r = new ByteReader(new Uint8Array([0x03, 1, 2]));
    expect(() => r.readArray<number>((r) => r.readU8())).toThrow();
  });

  test('readArray rejects length > 2^24', () => {
    // Encode (1 << 24) + 1 = 16777217 as VLQ using encodeVlqU, then feed it
    // to readArray. The bounds check must throw ReaderError with 'array-too-large'
    // BEFORE attempting allocation or reading any elements.
    const overlongLengthBytes = encodeVlqU(BigInt((1 << 24) + 1));
    const r = new ByteReader(overlongLengthBytes);
    let caught: unknown;
    try {
      r.readArray<number>((r) => r.readU8());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReaderError);
    expect((caught as ReaderError).code).toBe('array-too-large');
  });
});
