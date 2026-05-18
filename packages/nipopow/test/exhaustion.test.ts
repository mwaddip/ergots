/**
 * Reader-exhaustion checks (Codex audit Finding #3, medium).
 *
 * Three call sites must reject trailing bytes:
 *  1. parseProof root reader (proof.ts)
 *  2. PoPowHeader headerBytes subreader (popow-header.ts ~line 74)
 *  3. PoPowHeader proofBytes subreader (popow-header.ts ~line 102)
 *
 * Without these, `parseProof(valid + extra_byte)` accepts the malformed bytes
 * and `serializeProof(parseProof(valid + extra_byte))` silently drops the
 * trailing byte. This is a malleability bug.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseProof, serializeProof } from '../src/proof.ts';
import { ProofParseError } from '../src/errors.ts';
import { hexToBytes } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'fixtures/nipopow_proof.json');
const corpus = JSON.parse(readFileSync(fixturePath, 'utf8')) as { label: string; bytes_hex: string }[];
const validHex = corpus[0]!.bytes_hex;
const validBytes = hexToBytes(validHex);

describe('parser reader-exhaustion (Codex audit Finding #3)', () => {
  test('parseProof rejects a single trailing byte appended to a valid proof', () => {
    const malformed = new Uint8Array(validBytes.length + 1);
    malformed.set(validBytes, 0);
    malformed[validBytes.length] = 0xFF;
    expect(() => parseProof(malformed)).toThrow(ProofParseError);
  });

  test('parseProof + serializeProof do NOT silently drop trailing bytes', () => {
    // Before the fix: parseProof accepts the +1 byte; serializeProof(parsed) === validBytes (byte lost).
    // After the fix: parseProof throws.
    const malformed = new Uint8Array(validBytes.length + 1);
    malformed.set(validBytes, 0);
    malformed[validBytes.length] = 0xFF;
    let dropped = false;
    try {
      const reparsed = parseProof(malformed);
      const reserialized = serializeProof(reparsed);
      dropped = reserialized.length === validBytes.length;
    } catch {
      dropped = false;
    }
    expect(dropped).toBe(false);
  });

  test('valid proof still round-trips byte-exact (no regression)', () => {
    const parsed = parseProof(validBytes);
    const reserialized = serializeProof(parsed);
    expect(reserialized).toEqual(validBytes);
  });
});
