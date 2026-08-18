import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ByteReader, parseHeader } from '@ergots/scorex';
import { prove, proveWithReader } from '../src/prover.ts';
import { updateInterlinks, makePopowHeader } from '../src/interlinks.ts';
import { serializeProof } from '../src/proof.ts';
import type { PoPowHeader } from '../src/popow-header.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';
import { MemoryReader } from './reader-double.ts';

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

    for (const c of v.cases.filter((c: any) => c.headerId !== null)) {
      it(`${v.label} m=${c.m} k=${c.k} anchored@${c.headerId.slice(0, 8)} [${c.source}]: proveWithReader byte-identical`, async () => {
        // The SANTA fixture's `headerId` names the header that ends up buried k
        // blocks deep, NOT proveWithReader's own suffixHead-selecting `headerId`
        // parameter — two different things that happen to share a field name.
        // Per santa/docs/contract/runner-contract-nipopow.md §5's truncation
        // rule, the JVM generator built this fixture by running plain
        // NipopowAlgos.prove (no headerId at all) on `chain.take(idx + k + 1)`
        // where `idx` is headerId's 0-based position — so headerId is
        // preSuffix.last (one height BELOW suffixHead), verified empirically
        // against both real fixture chains (see task-8-report.md). To exercise
        // proveWithReader's actual `headerId` contract (facts/nipopow.md: given
        // id becomes suffixHead directly — the same contract
        // NipopowProverWithDbAlgs's own JVM-native equivalence test,
        // PoPowAlgosWithDBSpec.scala "proof(histReader) for a header in the
        // past", asserts), feed it the id of the NEXT header (anchor height +
        // 1), matching the fixture's own truncation arithmetic.
        const anchorIdx = chain.findIndex(p => bytesToHex(p.header.id) === c.headerId);
        const suffixHeadId = chain[anchorIdx + 1]!.header.id;
        const proof = await proveWithReader(new MemoryReader(chain), { m: c.m, k: c.k }, suffixHeadId);
        expect(bytesToHex(serializeProof(proof))).toBe(c.proofHex);
      });
    }
  }
});
