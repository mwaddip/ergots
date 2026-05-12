import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseAutolykosSolution, serializeAutolykosSolution } from '../src/autolykos-solution';
import { ProofParseError } from '../src/errors';
import { ByteReader } from '../src/scorex/reader';
import { hexToBytes, bytesToHex } from './helpers';

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

describe('AutolykosSolution', () => {
  for (let i = 0; i < fixtures.length; i++) {
    const c = fixtures[i]!;
    test(`case ${i}: parse + round-trip`, () => {
      const r = new ByteReader(hexToBytes(c.bytes_hex));
      const parsed = parseAutolykosSolution(r);
      expect(bytesToHex(parsed.minerPk)).toBe(c.miner_pk_hex);
      expect(parsed.powOnetimePk).toBe(null);
      expect(bytesToHex(parsed.nonce)).toBe(c.nonce_hex);
      expect(parsed.powDistance).toBe(null);

      const re = serializeAutolykosSolution(parsed);
      expect(bytesToHex(re)).toBe(c.bytes_hex);
    });
  }

  test('truncated input throws ProofParseError', () => {
    const r = new ByteReader(hexToBytes('00'.repeat(32))); // 32 bytes — short by 9
    try {
      parseAutolykosSolution(r);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofParseError);
      expect((e as InstanceType<typeof ProofParseError>).code).toBe('truncated');
    }
  });
});
