import { describe, test, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseAutolykosSolution, serializeAutolykosSolution, type ValidatePointFn } from '../src/autolykos-solution.ts';
import { ByteReader } from '../src/reader.ts';
import { ReaderError } from '../src/errors.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SolutionCase {
  miner_pk_hex: string;
  pow_onetime_pk_hex: string | null;
  nonce_hex: string;
  pow_distance: string | null;
  bytes_hex: string;
}
const fixtures: SolutionCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/autolykos_solution.json'), 'utf8')
);

// Distinguishable from ReaderError's fixed code union (see errors.ts) so a caught
// 'position-limit-exceeded' can never be mistaken for a stub rejection.
class StubRejectError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

// A v1 solution buffer: minerPk(33) + powOnetimePk(33) + nonce(8) + dLen(1) + d(1).
function v1SolutionBytes(): Uint8Array {
  const bytes = new Uint8Array(33 + 33 + 8 + 1 + 1);
  bytes[74] = 1; // dLen = 1
  bytes[75] = 5; // d = [0x05]
  return bytes;
}

describe('AutolykosSolution', () => {
  for (let i = 0; i < fixtures.length; i++) {
    const c = fixtures[i]!;
    test(`case ${i}: parse + round-trip`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      const parsed = parseAutolykosSolution(r, 2);
      expect(bytesToHex(parsed.minerPk)).toBe(c.miner_pk_hex);
      expect(parsed.powOnetimePk).toBe(null);
      expect(bytesToHex(parsed.nonce)).toBe(c.nonce_hex);
      expect(parsed.powDistance).toBe(null);

      const re = serializeAutolykosSolution(parsed, 2);
      expect(bytesToHex(re)).toBe(c.bytes_hex);
    });
  }

  test('truncated input throws ReaderError', () => {
    const r = new ByteReader(hexToBytes('00'.repeat(32))); // 32 bytes — short by 9
    try {
      parseAutolykosSolution(r, 2);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ReaderError);
      expect((e as ReaderError).code).toBe('truncated');
    }
  });

  it('a v1 d length of 0 still runs getBytes (the window check), ErgoHeader.scala:76-77', () => {
    const bytes = new Uint8Array(33 + 33 + 8 + 1)   // minerPk, powOnetimePk, nonce, dLen = 0
    const r = new ByteReader(bytes)
    r.positionLimit = 74                            // after dLen the position is 75
    let code: string | undefined
    try { parseAutolykosSolution(r, 1) } catch (e) { code = (e as { code?: string }).code }
    expect(code).toBe('position-limit-exceeded')
  })

  it('a v1 invalid minerPk rejects before powOnetimePk is read, before the next read trips the window', () => {
    const r = new ByteReader(v1SolutionBytes())
    r.positionLimit = 32 // minerPk's read at 0 passes; powOnetimePk's read at 33 would trip this
    const validatePoint: ValidatePointFn = (bytes, field) => {
      if (field === 'minerPk') throw new StubRejectError('stub-reject-minerPk')
      return bytes
    }
    let code: string | undefined
    try { parseAutolykosSolution(r, 1, validatePoint) } catch (e) { code = (e as { code?: string }).code }
    expect(code).toBe('stub-reject-minerPk')
  })

  it('a v1 invalid powOnetimePk rejects before the nonce read trips the window', () => {
    const r = new ByteReader(v1SolutionBytes())
    r.positionLimit = 65 // powOnetimePk's read at 33 passes; the nonce read at 66 would trip this
    const validatePoint: ValidatePointFn = (bytes, field) => {
      if (field === 'powOnetimePk') throw new StubRejectError('stub-reject-powOnetimePk')
      return bytes
    }
    let code: string | undefined
    try { parseAutolykosSolution(r, 1, validatePoint) } catch (e) { code = (e as { code?: string }).code }
    expect(code).toBe('stub-reject-powOnetimePk')
  })

  it('validatePoint is called for both v1 points, in order minerPk then powOnetimePk, when neither rejects', () => {
    const r = new ByteReader(v1SolutionBytes()) // default positionLimit: no window truncation
    const calls: Array<'minerPk' | 'powOnetimePk'> = []
    const validatePoint: ValidatePointFn = (bytes, field) => {
      calls.push(field)
      return bytes
    }
    const sol = parseAutolykosSolution(r, 1, validatePoint)
    expect(calls).toEqual(['minerPk', 'powOnetimePk'])
    expect(sol.powDistance).toBe(5n)
  })
});
