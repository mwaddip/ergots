import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { encodeVlqU, decodeVlqU, encodeVlqZigZag, decodeVlqZigZag } from '../src/scorex/vlq';
import { ByteReader } from '../src/scorex/reader';
import { ProofParseError } from '../src/errors';
import { hexToBytes } from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface VlqCase { value: string; bytes_hex: string; }
interface VlqFixtures { u64: VlqCase[]; i64: VlqCase[]; }

const fixture: VlqFixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/vlq.json'), 'utf8')
);

describe('VLQ unsigned', () => {
  for (const c of fixture.u64) {
    test(`encode ${c.value} -> ${c.bytes_hex}`, () => {
      expect(encodeVlqU(BigInt(c.value))).toEqual(hexToBytes(c.bytes_hex));
    });
    test(`decode ${c.bytes_hex} -> ${c.value}`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      expect(decodeVlqU(r)).toBe(BigInt(c.value));
    });
  }

  test('decode of truncated input throws ProofParseError', () => {
    const r = new ByteReader(new Uint8Array([0x80, 0x80])); // continuation bytes without terminator
    expect(() => decodeVlqU(r)).toThrow(ProofParseError);
  });

  test('decode of overlong input throws ProofParseError with vlq-overflow', () => {
    const overlong = new Uint8Array(11).fill(0x80);
    overlong[10] = 0x01; // terminator after 10 continuation bytes (would represent a value > u64)
    const r = new ByteReader(overlong);
    try {
      decodeVlqU(r);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as ProofParseError).code).toBe('vlq-overflow');
    }
  });

  test('encode rejects negative', () => {
    expect(() => encodeVlqU(-1n)).toThrow(/negative/);
  });
});

describe('VLQ zigzag (signed)', () => {
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
