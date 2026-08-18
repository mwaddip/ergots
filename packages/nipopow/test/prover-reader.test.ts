import { describe, it, expect } from 'vitest';
import { prove, proveWithReader } from '../src/prover.ts';
import { serializeProof, parseProof } from '../src/proof.ts';
import { verifyParsedProof } from '../src/verifier.ts';
import { MemoryReader } from './reader-double.ts';
import { buildTestChain, bytesToHex } from './helpers.ts';

const SHAPES: [number[], number, number][] = [
  [[0, 0, 1, 0, 2, 0, 1, 0], 1, 1],
  [[0, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0], 2, 2],
  [[0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 0, 1, 0], 2, 3],
  [[0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 0, 1, 0, 1, 0, 4, 0, 0, 1, 0, 2], 3, 4],
];

describe('proveWithReader equivalence with prove()', () => {
  // FINDING (Task 8 investigation, full detail in task-8-report.md): prove()
  // (NipopowAlgos.prove, filter-based) and proveWithReader
  // (NipopowProverWithDbAlgs.prove, interlink-walk-based) are NOT byte-identical
  // in general on arbitrary chains — confirmed by reading both JVM sources, not
  // a TS-port bug:
  //
  //  1. Genesis "free credit": NipopowAlgos.scala's provePrefix filters
  //     `chain.dropRight(k)` by `maxLevelOf(h) >= level && h.height >=
  //     anchoringPoint.height`. Genesis (maxLevelOf = Int.MaxValue, height = 1)
  //     trivially satisfies this at EVERY level until the anchor first advances
  //     past height 1, giving prove() a "free" +1 at the topmost not-yet-narrowed
  //     level. NipopowProverWithDbAlgs's collectLevel walk can never discover
  //     genesis (it is never present in any header's interlinks TAIL, only ever
  //     the special position-0 slot) — no walk-side counterpart to that +1. When
  //     the *true* (non-genesis) count at that level equals exactly `m`, the
  //     `m < count` narrowing decision flips between the two algorithms.
  //  2. No walk position for "level 0": `linksWithIndexes` = `interlinks.tail
  //     .reverse.zipWithIndex` only ever produces positions for levels >= 1 (the
  //     tail encodes skip pointers for level >=1 only; level >=0 is trivially
  //     every block via plain parent-child adjacency, so no interlink position
  //     represents it). NipopowAlgos.prove's explicit `level = 0` pass therefore
  //     has no counterpart walk in NipopowProverWithDbAlgs — a run of
  //     consecutive level-0 blocks whose id is never recorded in any later
  //     block's interlinks (updateInterlinks only records a PARENT's id when the
  //     parent's own level >= 1) is structurally undiscoverable by the walk, yet
  //     prove()'s level-0 filter sweeps every such block in unconditionally.
  //
  // Both mechanisms are real properties of the actual JVM sources
  // (NipopowAlgos.scala, NipopowProverWithDbAlgs.scala) — proveWithReader here is
  // a faithful, line-by-line port of NipopowProverWithDbAlgs.prove, confirmed
  // byte-identical to real JVM ground truth (prover-santa.test.ts: 6/6 tip-mode +
  // 2/2 anchored-mode cases against real 32/64-header JVM-generated chains) and
  // consistent with the JVM's own equivalence-test methodology
  // (PoPowAlgosWithDBSpec.scala asserts this same equivalence, but only against a
  // realistic genChain(3000) — never a short, densely hand-scripted chain like
  // the SHAPES below). Neither edge case is expected to bite on a realistic,
  // organically-grown chain, and empirically neither does on any real fixture
  // checked. The SHAPES chains here are short and densely packed by
  // construction specifically to exercise proveWithReader's walk machinery
  // cheaply, so they DO trip these two edges — the assertions below are scoped
  // to what holds universally (suffix selection, and proveWithReader's own
  // structural validity as a KMZ17 proof), not to full byte-identity with
  // prove(), which prover-santa.test.ts already covers against real data.
  for (const [levels, m, k] of SHAPES) {
    it(`levels[${levels.length}] m=${m} k=${k}: suffix matches prove(), prefix is a valid KMZ17 prefix`, async () => {
      const chain = buildTestChain(levels);
      const fromMemory = await proveWithReader(new MemoryReader(chain), { m, k });
      const direct = prove(chain, { m, k });

      // Suffix selection never depends on the prefix-construction algorithm —
      // both algorithms take the suffix straight from the chain/reader.
      expect(bytesToHex(fromMemory.suffixHead.header.id)).toBe(bytesToHex(direct.suffixHead.header.id));
      expect(fromMemory.suffixTail.map(h => bytesToHex(h.id))).toEqual(direct.suffixTail.map(h => bytesToHex(h.id)));

      // proveWithReader's own output is a structurally valid, well-formed proof
      // (mirrors prover.test.ts's "prove() selection" invariant checks).
      const result = verifyParsedProof(fromMemory, { checkPoW: false });
      expect(result.totalHeaders).toBe(fromMemory.prefix.length + 1 + fromMemory.suffixTail.length);
      const bytes = serializeProof(fromMemory);
      expect(bytesToHex(serializeProof(parseProof(bytes)))).toBe(bytesToHex(bytes));

      const hs = fromMemory.prefix.map(p => p.header.height);
      expect([...new Set(hs)].sort((a, b) => a - b)).toEqual(hs); // strictly ascending, deduped
      expect(Math.max(...hs)).toBeLessThan(fromMemory.suffixHead.header.height);
      expect(hs[0]).toBe(1); // genesis anchored
    });
  }

  it('anchored mode: headerId mid-chain ≡ proveWithReader tip-mode on the truncated chain', async () => {
    // Oracle is proveWithReader itself (same algorithm), not prove() — see the
    // block comment above: cross-algorithm byte-identity is not guaranteed on
    // arbitrary chains, only same-algorithm self-consistency is. This asserts
    // the property that IS always true: anchored suffix selection against the
    // full reader walks the same interlink graph as tip-mode against a reader
    // truncated exactly past the anchor's k-suffix (the backward-only walk from
    // suffixHead can never observe anything past it regardless of what else the
    // reader holds).
    const [levels, m, k] = SHAPES[3]!;
    const chain = buildTestChain(levels);
    const anchorIdx = chain.length - 1 - 4; // suffixHead 4 from tip
    const anchorId = chain[anchorIdx]!.header.id;
    const anchored = await proveWithReader(new MemoryReader(chain), { m, k }, anchorId);
    expect(anchored.suffixHead.header.height).toBe(anchorIdx + 1);
    const truncated = chain.slice(0, anchorIdx + k); // suffix = anchor + k-1 after it
    const tipOnTruncated = await proveWithReader(new MemoryReader(truncated), { m, k });
    expect(bytesToHex(serializeProof(anchored)))
      .toBe(bytesToHex(serializeProof(tipOnTruncated)));
  });
});

describe('proveWithReader errors + load bound', () => {
  it('gates: invalid-m / invalid-k / chain-too-short', async () => {
    const chain = buildTestChain([0, 0, 1, 0]);
    await expect(proveWithReader(new MemoryReader(chain), { m: 0, k: 1 })).rejects.toMatchObject({ code: 'invalid-m' });
    await expect(proveWithReader(new MemoryReader(chain), { m: 1, k: 0 })).rejects.toMatchObject({ code: 'invalid-k' });
    await expect(proveWithReader(new MemoryReader(chain), { m: 3, k: 2 })).rejects.toMatchObject({ code: 'chain-too-short' });
  });

  it('missing header → missing-popow-header', async () => {
    const chain = buildTestChain(SHAPES[1]![0]);
    const reader = new MemoryReader(chain);
    reader.popowHeaderAtHeight = async () => { reader.calls++; return null; }; // genesis fetch dies
    await expect(proveWithReader(reader, { m: 2, k: 2 })).rejects.toMatchObject({ code: 'missing-popow-header' });
  });

  it('load count ≪ N (no accidental full scan)', async () => {
    const levels = Array.from({ length: 120 }, (_, i) => [0, 0, 1, 0, 2, 0, 1, 0, 3, 0][i % 10]!);
    const chain = buildTestChain(levels);
    const reader = new MemoryReader(chain);
    const m = 3, k = 3;
    await proveWithReader(reader, { m, k });
    // Loose bound: c·(m + k + m·log2 N) with c = 6 — fails hard on O(N).
    const bound = 6 * (m + k + m * Math.log2(chain.length));
    expect(reader.calls).toBeLessThan(bound);
    expect(reader.calls).toBeLessThan(chain.length); // and strictly under N
  });
});
