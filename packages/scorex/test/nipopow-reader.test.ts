import { describe, test, expect } from 'vitest';
import { ByteReader, ReaderError } from '../src/scorex/reader';

describe('ByteReader', () => {
  test('readU8 returns first byte and advances', () => {
    const r = new ByteReader(new Uint8Array([0xab, 0xcd]));
    expect(r.readU8()).toBe(0xab);
    expect(r.position).toBe(1);
    expect(r.readU8()).toBe(0xcd);
    expect(r.position).toBe(2);
  });

  test('readU8 throws on EOF', () => {
    const r = new ByteReader(new Uint8Array([]));
    expect(() => r.readU8()).toThrow(ReaderError);
  });

  test('readBytes returns exact count', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4]));
    expect(r.readBytes(3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.position).toBe(3);
  });

  test('readBytes throws on insufficient bytes', () => {
    const r = new ByteReader(new Uint8Array([1, 2]));
    expect(() => r.readBytes(3)).toThrow(ReaderError);
  });

  test('readBytes(0) returns empty slice without advancing position', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3]));
    expect(r.readBytes(0)).toEqual(new Uint8Array([]));
    expect(r.position).toBe(0);
    expect(r.readU8()).toBe(1); // next read still sees byte 0
  });

  test('remaining returns count of unread bytes', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3]));
    r.readU8();
    expect(r.remaining).toBe(2);
  });

  test('isExhausted true at end', () => {
    const r = new ByteReader(new Uint8Array([1]));
    expect(r.isExhausted).toBe(false);
    r.readU8();
    expect(r.isExhausted).toBe(true);
  });
});
