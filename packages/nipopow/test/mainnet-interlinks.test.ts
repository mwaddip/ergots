import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ByteReader, parseHeader } from '@ergots/scorex';
import { updateInterlinks, makePopowHeader } from '../src/interlinks.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = JSON.parse(readFileSync(join(FIX, 'mainnet_consecutive.json'), 'utf8'));

function headerAt(i: number) {
  const r = new ByteReader(hexToBytes(fx.heights[i].headerHex));
  const h = parseHeader(r);
  expect(bytesToHex(h.id)).toBe(fx.heights[i].id); // id anchors the whole entry
  return h;
}

describe('mainnet consecutive headers (real powHit ground truth)', () => {
  it('updateInterlinks reproduces every next-height interlinks vector', () => {
    for (let i = 0; i + 1 < fx.heights.length; i++) {
      const prev = headerAt(i);
      const prevLinks = fx.heights[i].interlinks.map(hexToBytes);
      const computed = updateInterlinks(prev, prevLinks).map(bytesToHex);
      expect(computed, `h=${fx.heights[i].height} → ${fx.heights[i + 1].height}`)
        .toEqual(fx.heights[i + 1].interlinks);
    }
  });

  it('makePopowHeader reproduces every captured interlinksProof field-for-field', () => {
    for (let i = 0; i < fx.heights.length; i++) {
      const ph = makePopowHeader(headerAt(i), fx.heights[i].interlinks.map(hexToBytes));
      const want = fx.heights[i].interlinksProof;
      expect(ph.interlinksProof.indices.map(e => ({ index: e.index, digestHex: bytesToHex(e.hash) })))
        .toEqual(want.indices);
      expect(ph.interlinksProof.proofs.map(e => ({
        digestHex: e.hash === null ? '00'.repeat(32) : bytesToHex(e.hash),
        side: e.side,
      }))).toEqual(want.proofs);
    }
  });
});
