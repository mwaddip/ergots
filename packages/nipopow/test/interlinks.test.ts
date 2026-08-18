import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxLevelOf, ORDER } from '../src/level.ts';
import {
  updateInterlinks, unpackInterlinks, proofForInterlinkVector, makePopowHeader,
} from '../src/interlinks.ts';
import { packInterlinks, serializeBatchMerkleProof } from '../src/merkle.ts';
import { parseProof } from '../src/proof.ts';
import { ProofBuildError } from '../src/errors.ts';
import { headerWithHit, makeId, hexToBytes, bytesToHex } from './helpers.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const proofFixtures = JSON.parse(readFileSync(join(FIX, 'nipopow_proof.json'), 'utf8'));

const REQUIRED = ORDER / 4096n; // file scope, shared by maxLevelOf + updateInterlinks blocks

describe('maxLevelOf (shared level.ts)', () => {
  it('truncates toward zero at the level-0 boundary (JVM Double.toInt), not floor', () => {
    // hit = 1.5 × required → exact level = log2(2/3) ≈ −0.585
    // JVM (−0.585).toInt = 0; Math.floor would give −1.
    expect(maxLevelOf(headerWithHit(5, REQUIRED + REQUIRED / 2n))).toBe(0);
  });

  it('positive levels unchanged: hit = required/9 → level 3', () => {
    // ratio 9 → log2 ≈ 3.17 → trunc 3 (same as floor)
    expect(maxLevelOf(headerWithHit(5, REQUIRED / 9n))).toBe(3);
  });

  it('genesis is MAX_SAFE_INTEGER', () => {
    expect(maxLevelOf(headerWithHit(1, REQUIRED))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('updateInterlinks', () => {
  const genesisId = makeId(1);

  it('genesis prev → [genesis.id]', () => {
    const g = headerWithHit(1, REQUIRED);
    expect(updateInterlinks(g, []).map(bytesToHex)).toEqual([bytesToHex(g.id)]);
  });

  it('non-genesis with empty interlinks throws empty-interlinks', () => {
    const h = headerWithHit(5, REQUIRED);
    expect(() => updateInterlinks(h, [])).toThrowError(ProofBuildError);
    try { updateInterlinks(h, []); } catch (e) {
      expect((e as ProofBuildError).code).toBe('empty-interlinks');
    }
  });

  it('level 0 → unchanged contents, fresh array', () => {
    const prev = headerWithHit(5, REQUIRED + REQUIRED / 2n); // level 0 (trunc)
    const links = [genesisId, makeId(4)];
    const out = updateInterlinks(prev, links);
    expect(out.map(bytesToHex)).toEqual(links.map(bytesToHex));
    expect(out).not.toBe(links);
  });

  it('level 2, tail length 3 → drop last 2, append prev.id ×2', () => {
    const prev = headerWithHit(9, REQUIRED / 4n); // ratio 4 → level 2
    const links = [genesisId, makeId(2), makeId(3), makeId(4)];
    expect(updateInterlinks(prev, links).map(bytesToHex)).toEqual(
      [genesisId, makeId(2), prev.id, prev.id].map(bytesToHex));
  });

  it('level 3, tail length 1 → grows: [genesis, prev.id ×3]', () => {
    const prev = headerWithHit(9, REQUIRED / 9n); // level 3
    const links = [genesisId, makeId(2)];
    expect(updateInterlinks(prev, links).map(bytesToHex)).toEqual(
      [genesisId, prev.id, prev.id, prev.id].map(bytesToHex));
  });
});

describe('unpackInterlinks', () => {
  it('round-trips packInterlinks incl. duplicate runs', () => {
    const links = [makeId(1), makeId(2), makeId(2), makeId(2), makeId(3)];
    expect(unpackInterlinks(packInterlinks(links)).map(bytesToHex))
      .toEqual(links.map(bytesToHex));
  });

  it('ignores non-interlink-prefixed fields', () => {
    const fields = packInterlinks([makeId(1), makeId(2)]);
    fields.push({ key: new Uint8Array([0x02, 0x00]), value: new Uint8Array(5) });
    expect(unpackInterlinks(fields).map(bytesToHex))
      .toEqual([makeId(1), makeId(2)].map(bytesToHex));
  });

  it('rejects a 32-byte (or 34-byte) interlink value: malformed-interlinks', () => {
    for (const len of [32, 34]) {
      const bad = [{ key: new Uint8Array([0x01, 0x00]), value: new Uint8Array(len) }];
      expect(() => unpackInterlinks(bad)).toThrowError(ProofBuildError);
      try { unpackInterlinks(bad); } catch (e) {
        expect((e as ProofBuildError).code).toBe('malformed-interlinks');
      }
    }
  });

  it('empty fields → empty interlinks', () => {
    expect(unpackInterlinks([])).toEqual([]);
  });
});

describe('proofForInterlinkVector + makePopowHeader vs nipopow_proof.json', () => {
  it('zero interlink fields → empty proof', () => {
    const p = proofForInterlinkVector([]);
    expect(p.indices).toEqual([]);
    expect(p.proofs).toEqual([]);
  });

  for (const fx of proofFixtures) {
    it(`${fx.label}: makePopowHeader reproduces every stored PoPowHeader proof`, () => {
      const parsed = parseProof(hexToBytes(fx.bytes_hex));
      const popowHeaders = [...parsed.prefix, parsed.suffixHead];
      for (const ph of popowHeaders) {
        const rebuilt = makePopowHeader(ph.header, ph.interlinks);
        expect(bytesToHex(serializeBatchMerkleProof(rebuilt.interlinksProof)))
          .toBe(bytesToHex(serializeBatchMerkleProof(ph.interlinksProof)));
        expect(rebuilt.interlinks.map(bytesToHex)).toEqual(ph.interlinks.map(bytesToHex));
        expect(rebuilt.header).toBe(ph.header);
      }
    });
  }
});
