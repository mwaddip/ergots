import { describe, it, test, expect } from 'vitest';
import { prove, proveWithReader, type PoPowParams } from '../src/prover.ts';
import { ProofBuildError } from '../src/errors.ts';
import { verifyParsedProof } from '../src/verifier.ts';
import { serializeProof, parseProof } from '../src/proof.ts';
import { heightsForNextRecalculation } from '../src/difficulty.ts';
import type { PoPowHeader } from '../src/popow-header.ts';
import { buildTestChain, bytesToHex } from './helpers.ts';
import { MemoryReader } from './reader-double.ts';

describe('prove() gates', () => {
  const chain = buildTestChain([0, 0, 1, 0, 2, 0, 1, 0]); // 8 headers
  const cases: [PoPowParams, PoPowHeader[], string][] = [
    [{ m: 0, k: 2 }, chain, 'invalid-m'],
    [{ m: 2, k: 0 }, chain, 'invalid-k'],
    [{ m: 5, k: 4 }, chain, 'chain-too-short'],       // 8 < 9
    [{ m: 2, k: 2 }, chain.slice(1), 'non-anchored-chain'],
  ];
  for (const [params, c, code] of cases) {
    it(`throws ${code}`, () => {
      expect(() => prove(c, params)).toThrowError(ProofBuildError);
      try { prove(c, params); } catch (e) {
        expect((e as ProofBuildError).code).toBe(code);
      }
    });
  }
});

describe('prove() selection', () => {
  it('hand-computed m=1 k=1 on 8 headers, levels [G,0,1,0,2,0,1,0]', () => {
    const chain = buildTestChain([0, 0, 1, 0, 2, 0, 1, 0]);
    const proof = prove(chain, { m: 1, k: 1 });
    // suffix = last 1 → suffixHead h8, empty tail
    expect(proof.suffixHead.header.height).toBe(8);
    expect(proof.suffixTail).toEqual([]);
    // Hand-derived KMZ17 trace (full derivation in the plan text — re-derive
    // independently before trusting this literal):
    //   h7.interlinks = [h1, h5, h5] → maxLevel 2
    //   level 2, anchor h1: {h1, h5} → 2 > m → anchor h5
    //   level 1, anchor h5: {h5, h7} → 2 > m → anchor h7
    //   level 0, anchor h7: {h7}
    //   distinct+sort → heights [1, 5, 7]
    expect(proof.prefix.map(p => p.header.height)).toEqual([1, 5, 7]);
    expect(proof.m).toBe(1);
    expect(proof.k).toBe(1);
  });

  it('every produced proof passes verifyParsedProof (checkPoW false) and round-trips', () => {
    for (const [levels, m, k] of [
      [[0, 0, 1, 0, 2, 0, 1, 0], 1, 1],
      [[0, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0], 2, 2],
      [[0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 0, 1, 0], 2, 3],
    ] as [number[], number, number][]) {
      const proof = prove(buildTestChain(levels), { m, k });
      const result = verifyParsedProof(proof, { checkPoW: false });
      expect(result.totalHeaders).toBe(proof.prefix.length + 1 + proof.suffixTail.length);
      const bytes = serializeProof(proof);
      expect(bytesToHex(serializeProof(parseProof(bytes)))).toBe(bytesToHex(bytes));
    }
  });

  it('prefix is strictly increasing, deduped, all below suffixHead', () => {
    const proof = prove(buildTestChain([0, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0]), { m: 2, k: 2 });
    const hs = proof.prefix.map(p => p.header.height);
    expect([...new Set(hs)].sort((a, b) => a - b)).toEqual(hs);
    expect(Math.max(...hs)).toBeLessThan(proof.suffixHead.header.height);
    expect(hs[0]).toBe(1); // genesis anchored
  });
});

describe('prove() continuous mode (deliberate divergence from JVM stamp-only NipopowAlgos.prove)', () => {
  const levels = Array.from({ length: 64 }, (_, i) => (i % 8 === 7 ? 2 : 1));
  const E = { epochLength: 16, useLastEpochs: 8 };

  test('injects gated needed heights, stamps the flag, and self-verifies', () => {
    const chain = buildTestChain(levels);
    const proof = prove(chain, { m: 3, k: 3, continuous: true, ...E });
    expect(proof.continuous).toBe(true);
    const sh = proof.suffixHead.header.height;
    const needed = heightsForNextRecalculation(sh, 16, 8).filter(h => h > 0 && h < sh);
    const prefixHeights = new Set(proof.prefix.map(p => p.header.height));
    for (const h of needed) expect(prefixHeights.has(h), `height ${h}`).toBe(true);
    const result = verifyParsedProof(proof, { checkPoW: false, ...E });
    expect(result.continuous).toBe(true);
  });

  test('continuous prove() === continuous proveWithReader() on the same chain (injection adds the identical set)', async () => {
    const chain = buildTestChain(levels);
    const a = prove(chain, { m: 3, k: 3, continuous: true, ...E });
    const b = await proveWithReader(new MemoryReader(chain), { m: 3, k: 3, continuous: true, ...E });
    expect(serializeProof(a)).toEqual(serializeProof(b));
  });

  // Note (task-7): on this `levels` chain, needed=[16,32,48] (for sh=62) are
  // ALREADY walk-selected independent of injection — the same superblock
  // coincidence prover-reader.test.ts documents for proveWithReader (every
  // multiple of epochLength=16 is also a multiple of this chain's own
  // 8-height superblock spacing). So the per-height containment loop above
  // passes vacuously here: it does not by itself discriminate "injection ran"
  // from "the walk already found these." That discrimination is already
  // pinned on the reader side (prover-reader.test.ts "injection adds exactly
  // the gated needed heights on top of the walk selection, nothing more",
  // using the level-0-gapped `sparseLevels` chain). This unit's unique value
  // is the cross-prover byte-equivalence test above plus the self-verify
  // roundtrip and the silent-skip test below — deliberately not redesigning
  // this chain to also chase injection-discrimination a second time.
  test('needed height absent from the chain argument is skipped silently (mirrors reader-path rule)', () => {
    const chain = buildTestChain(levels);
    const sh = 62;
    const needed = heightsForNextRecalculation(sh, 16, 8).filter(h => h > 0 && h < sh);
    const dropped = needed[0]!;
    const gappy = chain.filter(p => p.header.height !== dropped);
    const proof = prove(gappy, { m: 3, k: 3, continuous: true, ...E });
    expect(proof.prefix.some(p => p.header.height === dropped)).toBe(false);
    expect(proof.continuous).toBe(true);
  });
  // Adaptation note (task-7): unlike proveWithReader's GappyReader (which only
  // breaks the reader's `popowHeaderAtHeight` accessor while `popowHeaderById`
  // still reaches the full chain via interlink back-pointers — requiring
  // prover-reader.test.ts's level-0-gapped `sparseLevels` chain to guarantee
  // genuine walk-absence), prove()'s KMZ17 walk has no graph-traversal step at
  // all: `maxLevelOf` reads only the header's own PoW fields, and both the
  // walk (`preSuffix.filter(...)`) and the injection lookup
  // (`preSuffix.find(...)`) read the SAME flat `preSuffix` array. Filtering
  // `dropped`'s header out of the `chain` argument removes it from that array
  // entirely, so it is structurally unreachable by the walk too — no
  // interlink path can "re-include" it. The brief's `levels` chain therefore
  // does NOT need the `sparseLevels` motif swap here; this test is left as
  // specified and verified non-vacuous by construction (see task-7-report.md
  // for the derivation, including why `sh = 62` still holds after the
  // mid-chain filter).

  test('bad difficulty params throw RangeError with continuous=false too', () => {
    const chain = buildTestChain(levels);
    expect(() => prove(chain, { m: 3, k: 3, useLastEpochs: 1 })).toThrow(RangeError);
  });
});
