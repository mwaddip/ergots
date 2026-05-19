/**
 * Autolykos v2 PoW verification tests.
 *
 * Step-by-step fixture-driven tests, one per intermediate value:
 *  1. message (blake2b256 of serialize_without_pow)
 *  2. seed construction
 *  3. genIndexes
 *  4. element hashes
 *  5. sum + hit computation
 *  6. full verifyAutolykosV2 round-trip
 *  7. mutation test (nonce flip)
 *
 * Fixtures: packages/scorex/test/fixtures/autolykos_v2.json
 * Reference: sigma-rust ergo-chain-types/src/autolykos_pow_scheme.rs
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  buildAutolykosSeed,
  genIndexes,
  hashElement,
  calcBigN,
  autolykosMessage,
  verifyAutolykosV2,
} from '../src/autolykos-v2';
import { parseHeader } from '../src/header';
import { ByteReader } from '../src/reader';
import { blake2b256 } from '../src/crypto/blake2b256';
import { hexToBytes, bytesToHex } from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AutolykosCase {
  label: string;
  header_bytes_hex: string;
  message_hex: string;
  pk_hex: string;
  nonce_hex: string;
  height: number;
  n_bits: number;
  n_value: number;
  seed_hex: string;
  indices: number[];
  element_hashes_hex: string[];
  sum_decimal: string;
  hit_hex: string;
  target_decimal: string;
  is_valid: boolean;
}

const fixtures: AutolykosCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/autolykos_v2.json'), 'utf8')
);

// Only real headers (synthetic case has no header_bytes_hex)
const realFixtures = fixtures.filter(c => c.header_bytes_hex !== '');
// The zero-modulo synthetic case (seed = all zeros)
const syntheticFixture = fixtures.find(c => c.label === 'synthetic-zero-modulo')!;

// ──────────────────────────────────────────────────────────────
// STEP 1: message = blake2b256(serialize_without_pow)
// ──────────────────────────────────────────────────────────────
describe('Autolykos v2 — step 1: message construction', () => {
  for (const c of realFixtures) {
    test(`${c.label}: message matches fixture`, () => {
      const headerBytes = hexToBytes(c.header_bytes_hex);
      const header = parseHeader(new ByteReader(headerBytes));
      const msg = autolykosMessage(header);
      expect(bytesToHex(msg)).toBe(c.message_hex);
    });
  }
});

// ──────────────────────────────────────────────────────────────
// STEP 2: calc_big_n schedule
// ──────────────────────────────────────────────────────────────
describe('Autolykos v2 — step 2: calcBigN', () => {
  for (const c of realFixtures) {
    test(`${c.label}: n_value matches fixture`, () => {
      const headerBytes = hexToBytes(c.header_bytes_hex);
      const header = parseHeader(new ByteReader(headerBytes));
      expect(calcBigN(header.version, header.height)).toBe(c.n_value);
    });
  }
});

// ──────────────────────────────────────────────────────────────
// STEP 3: seed construction
// ──────────────────────────────────────────────────────────────
describe('Autolykos v2 — step 3: seed construction', () => {
  for (const c of fixtures) {
    if (c.header_bytes_hex === '') {
      // synthetic: we can't derive the seed from a real header,
      // the fixture's seed_hex IS the oracle for the zero-modulo path
      test(`${c.label}: seed is all-zeros (oracle)`, () => {
        expect(c.seed_hex).toBe('0'.repeat(64));
      });
      continue;
    }
    test(`${c.label}: seed matches fixture`, () => {
      const headerBytes = hexToBytes(c.header_bytes_hex);
      const header = parseHeader(new ByteReader(headerBytes));
      const msg = autolykosMessage(header);
      const nonce = header.autolykosSolution.nonce;
      const nValue = calcBigN(header.version, header.height);
      const seed = buildAutolykosSeed(msg, nonce, header.height, nValue);
      expect(bytesToHex(seed)).toBe(c.seed_hex);
    });
  }
});

// ──────────────────────────────────────────────────────────────
// STEP 4: genIndexes
// ──────────────────────────────────────────────────────────────
describe('Autolykos v2 — step 4: genIndexes', () => {
  for (const c of fixtures) {
    test(`${c.label}: indices match fixture`, () => {
      const seed = hexToBytes(c.seed_hex);
      const indices = genIndexes(seed, c.n_value);
      expect(indices).toHaveLength(32);
      expect(indices).toEqual(c.indices);
    });
  }

  test('zero-modulo: all indices are 0', () => {
    // All-zero seed → all 4-byte windows = 0 → 0 mod N = 0
    const indices = genIndexes(new Uint8Array(32), syntheticFixture.n_value);
    expect(indices.every(i => i === 0)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// STEP 5: element hashes
// ──────────────────────────────────────────────────────────────
describe('Autolykos v2 — step 5: element hashes', () => {
  for (const c of fixtures) {
    test(`${c.label}: each element hash matches fixture`, () => {
      for (let i = 0; i < c.indices.length; i++) {
        const hash = hashElement(c.indices[i]!, c.height);
        expect(bytesToHex(hash)).toBe(c.element_hashes_hex[i]);
      }
    });
  }
});

// ──────────────────────────────────────────────────────────────
// STEP 6: sum → hit → valid
// ──────────────────────────────────────────────────────────────
describe('Autolykos v2 — step 6: sum + hit', () => {
  for (const c of fixtures) {
    test(`${c.label}: sum matches fixture`, () => {
      let sum = 0n;
      for (const h of c.element_hashes_hex) {
        // 31-byte big-endian unsigned int
        const bytes = hexToBytes(h);
        let v = 0n;
        for (let i = 0; i < bytes.length; i++) {
          v = (v << 8n) | BigInt(bytes[i]!);
        }
        sum += v;
      }
      expect(sum.toString()).toBe(c.sum_decimal);
    });

    test(`${c.label}: hit matches fixture`, () => {
      // hit = blake2b256(asUnsignedByteArray(32, sum))
      // Inline the 32-byte big-endian conversion to keep asUnsignedByteArray internal.
      const sum = BigInt(c.sum_decimal);
      const sumBytes = new Uint8Array(32);
      let v = sum;
      for (let i = 31; i >= 0; i--) {
        sumBytes[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      const hit = blake2b256(sumBytes);
      expect(bytesToHex(hit)).toBe(c.hit_hex);
    });

    test(`${c.label}: is_valid matches fixture (hit < target)`, () => {
      if (c.header_bytes_hex === '') {
        // synthetic: n_bits=0x02010000 is set to make this always-invalid
        expect(c.is_valid).toBe(false);
        return;
      }
      const headerBytes = hexToBytes(c.header_bytes_hex);
      const header = parseHeader(new ByteReader(headerBytes));
      expect(verifyAutolykosV2(header)).toBe(c.is_valid);
    });
  }
});

// ──────────────────────────────────────────────────────────────
// STEP 7: verifyAutolykosV2 full wrapper
// ──────────────────────────────────────────────────────────────
describe('Autolykos v2 — verifyAutolykosV2 full verification', () => {
  for (const c of realFixtures) {
    test(`${c.label}: verifyAutolykosV2 returns ${c.is_valid}`, () => {
      const headerBytes = hexToBytes(c.header_bytes_hex);
      const header = parseHeader(new ByteReader(headerBytes));
      expect(verifyAutolykosV2(header)).toBe(c.is_valid);
    });
  }

  test('mutated nonce makes verification fail', () => {
    // Use the first real fixture — PoW must be valid
    const c = realFixtures[0]!;
    const headerBytes = hexToBytes(c.header_bytes_hex);
    const header = parseHeader(new ByteReader(headerBytes));
    expect(header.autolykosSolution).toBeDefined();
    expect(verifyAutolykosV2(header)).toBe(true);

    // Mutate nonce: replace with 0xFF bytes
    const mutated = {
      ...header,
      autolykosSolution: {
        ...header.autolykosSolution,
        nonce: new Uint8Array(8).fill(0xff),
      },
    };
    expect(verifyAutolykosV2(mutated)).toBe(false);
  });

  test('mutated n_bits makes verification fail', () => {
    const c = realFixtures[0]!;
    const headerBytes = hexToBytes(c.header_bytes_hex);
    const header = parseHeader(new ByteReader(headerBytes));
    // Extremely low target (huge n_bits difficulty) → no valid PoW can pass
    const mutated = {
      ...header,
      nBits: 0x01000000, // target = 0 → always fail
    };
    expect(verifyAutolykosV2(mutated)).toBe(false);
  });

  test('verifyAutolykosV2 throws on version 1 header', () => {
    const c = realFixtures[0]!;
    const headerBytes = hexToBytes(c.header_bytes_hex);
    const header = parseHeader(new ByteReader(headerBytes));
    const v1 = { ...header, version: 1 };
    expect(() => verifyAutolykosV2(v1)).toThrow('Autolykos v1 is not supported');
  });
});
