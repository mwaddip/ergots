import { describe, it, expect } from 'vitest';
import { ByteReader, ReaderError } from '../src/wire/reader';

describe('ByteReader', () => {
  it('reads u8', () => {
    const r = new ByteReader(new Uint8Array([0x42, 0xff]));
    expect(r.readU8()).toBe(0x42);
    expect(r.readU8()).toBe(0xff);
    expect(r.remaining).toBe(0);
  });

  it('reads VLQ unsigned', () => {
    // 0 -> [0x00]; 127 -> [0x7f]; 128 -> [0x80, 0x01]; 16383 -> [0xff, 0x7f]
    expect(new ByteReader(new Uint8Array([0x00])).readVlqU()).toBe(0);
    expect(new ByteReader(new Uint8Array([0x7f])).readVlqU()).toBe(127);
    expect(new ByteReader(new Uint8Array([0x80, 0x01])).readVlqU()).toBe(128);
    expect(new ByteReader(new Uint8Array([0xff, 0x7f])).readVlqU()).toBe(16383);
  });

  it('reads ZigZag-VLQ signed', () => {
    // ZigZag: 0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, 2 -> 4
    expect(new ByteReader(new Uint8Array([0])).readVlqS()).toBe(0);
    expect(new ByteReader(new Uint8Array([1])).readVlqS()).toBe(-1);
    expect(new ByteReader(new Uint8Array([2])).readVlqS()).toBe(1);
    expect(new ByteReader(new Uint8Array([3])).readVlqS()).toBe(-2);
    expect(new ByteReader(new Uint8Array([4])).readVlqS()).toBe(2);
  });

  it('reads fixed-length byte slice', () => {
    const r = new ByteReader(new Uint8Array([1, 2, 3, 4, 5]));
    expect(r.readBytes(3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.remaining).toBe(2);
  });

  it('throws on read past end', () => {
    const r = new ByteReader(new Uint8Array([0x01]));
    r.readU8();
    expect(() => r.readU8()).toThrow(ReaderError);
  });

  it('throws on VLQ overflow (>10 bytes)', () => {
    const bombBytes = new Uint8Array(11).fill(0x80);
    expect(() => new ByteReader(bombBytes).readVlqU()).toThrow(ReaderError);
  });
});
