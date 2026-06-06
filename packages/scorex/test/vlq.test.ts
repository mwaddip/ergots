import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { encodeVlqU, decodeVlqU, encodeVlqZigZag, decodeVlqZigZag, ByteReader, ReaderError } from '../src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface VlqCase { value: string; bytes_hex: string; }
interface VlqFixtures { u64: VlqCase[]; i64: VlqCase[]; }

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const fixture: VlqFixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/vlq.json'), 'utf8')
);

describe('VLQ unsigned (scorex free functions)', () => {
  for (const c of fixture.u64) {
    test(`encode ${c.value} -> ${c.bytes_hex}`, () => {
      expect(encodeVlqU(BigInt(c.value))).toEqual(hexToBytes(c.bytes_hex));
    });
    test(`decode ${c.bytes_hex} -> ${c.value}`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      expect(decodeVlqU(r)).toBe(BigInt(c.value));
    });
  }

  test('decode of truncated input throws ReaderError', () => {
    const r = new ByteReader(new Uint8Array([0x80, 0x80])); // continuation bytes without terminator
    expect(() => decodeVlqU(r)).toThrow(ReaderError);
  });

  test('decode of overlong input throws ReaderError with vlq-overflow', () => {
    const overlong = new Uint8Array(11).fill(0x80);
    overlong[10] = 0x01; // terminator after 10 continuation bytes (would represent a value > u64)
    const r = new ByteReader(overlong);
    try {
      decodeVlqU(r);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ReaderError);
      expect((e as ReaderError).code).toBe('vlq-overflow');
    }
  });

  test('encode rejects negative', () => {
    expect(() => encodeVlqU(-1n)).toThrow(/negative/);
  });

  test('encode rejects values above u64 max', () => {
    expect(() => encodeVlqU(0x10000000000000000n)).toThrow();
  });

  test('decode wraps mod 2^64 like the references (10th-byte high bits drop)', () => {
    // sigma-rust get_u64 / JVM getULong: result |= (b & 0x7F) << shift on a 64-bit
    // int — at shift=63 only bit 0 of the 10th byte survives. [0x80×9, 0x02]
    // encodes 2^64 via a 7-bit payload of 2 at shift=63, which wraps to 0 in both
    // references (2 << 63 = 2^64 mod 2^64 = 0).
    const r = new ByteReader(new Uint8Array([0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x02]));
    expect(decodeVlqU(r)).toBe(0n);
  });

  test('decode of u64 max round-trips', () => {
    const max = 0xffffffffffffffffn;
    const r = new ByteReader(encodeVlqU(max));
    expect(decodeVlqU(r)).toBe(max);
  });

  test('readVlqBigInt wraps mod 2^64 like the references (reader method form)', () => {
    // Same bytes as the decodeVlqU wrap test above, exercised through the reader
    // method (readVlqBigInt) to confirm both decode sites are fixed.
    const r = new ByteReader(new Uint8Array([0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x02]));
    expect(r.readVlqBigInt()).toBe(0n);
  });
});

describe('VLQ zigzag / signed (scorex free functions)', () => {
  for (const c of fixture.i64) {
    test(`encode ${c.value} -> ${c.bytes_hex}`, () => {
      expect(encodeVlqZigZag(BigInt(c.value))).toEqual(hexToBytes(c.bytes_hex));
    });
    test(`decode ${c.bytes_hex} -> ${c.value}`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      expect(decodeVlqZigZag(r)).toBe(BigInt(c.value));
    });
  }
});
