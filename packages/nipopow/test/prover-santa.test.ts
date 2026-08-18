import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ByteReader, parseHeader } from '@ergots/scorex';
import { prove } from '../src/prover.ts';
import { updateInterlinks, makePopowHeader } from '../src/interlinks.ts';
import { serializeProof } from '../src/proof.ts';
import type { PoPowHeader } from '../src/popow-header.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jvm_prover');
const vectors = readdirSync(DIR).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')));

describe('JVM prover vectors (SANTA)', () => {
  for (const v of vectors) {
    const chain: PoPowHeader[] = v.chain.map((e: any) =>
      makePopowHeader(parseHeader(new ByteReader(hexToBytes(e.headerHex))), e.interlinks.map(hexToBytes)));

    it(`${v.label}: our updateInterlinks reproduces every JVM interlinks vector`, () => {
      for (let i = 0; i + 1 < v.chain.length; i++) {
        expect(
          updateInterlinks(chain[i]!.header, v.chain[i].interlinks.map(hexToBytes)).map(bytesToHex),
          `height ${v.chain[i].height} → ${v.chain[i + 1].height}`,
        ).toEqual(v.chain[i + 1].interlinks);
      }
    });

    for (const c of v.cases.filter((c: any) => c.headerId === null)) {
      it(`${v.label} m=${c.m} k=${c.k} (tip): prove() byte-identical to JVM`, () => {
        expect(bytesToHex(serializeProof(prove(chain, { m: c.m, k: c.k })))).toBe(c.proofHex);
      });
    }
    // Anchored (headerId != null) cases are consumed by Task 8's reader tests.
  }
});
