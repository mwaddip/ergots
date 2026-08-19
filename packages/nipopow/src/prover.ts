/**
 * NiPoPoW proof construction — /prover subpath entry.
 *
 * JVM reference (canonical): NipopowAlgos.scala prove (in-memory, this file's
 * prove()) and NipopowProverWithDbAlgs.scala (reader-based walk, Task 8).
 * Clean-room: behavior reference only.
 */
import type { Header } from '@ergots/scorex';
import type { PoPowHeader } from './popow-header.ts';
import type { NipopowProof } from './proof.ts';
import { maxLevelOf } from './level.ts';
import { ProofBuildError } from './errors.ts';
import { bytesEqual } from './bytes.ts';

export type PoPowParams = { m: number; k: number };

export function prove(chain: PoPowHeader[], params: PoPowParams): NipopowProof {
  const { m, k } = params;
  if (!Number.isInteger(m) || m < 1) throw new ProofBuildError(`m must be >= 1, got ${m}`, 'invalid-m');
  if (!Number.isInteger(k) || k < 1) throw new ProofBuildError(`k must be >= 1, got ${k}`, 'invalid-k');
  if (chain.length < m + k) {
    throw new ProofBuildError(`cannot prove chain of size ${chain.length} < m+k=${m + k}`, 'chain-too-short');
  }
  if (chain[0]!.header.height !== 1) {
    throw new ProofBuildError('cannot prove a chain not anchored at genesis (height 1)', 'non-anchored-chain');
  }

  const suffix = chain.slice(chain.length - k);
  const suffixHead = suffix[0]!;
  const suffixTail: Header[] = suffix.slice(1).map(p => p.header);
  const preSuffix = chain.slice(0, chain.length - k);
  const maxLevel = preSuffix[preSuffix.length - 1]!.interlinks.length - 1;

  // JVM provePrefix (tail-recursive there; iterative here): walk levels from
  // maxLevel down to 0, collecting C[:-k]{B:}↑µ and narrowing the anchor to
  // the m-th-from-last entry whenever a level yields more than m headers.
  const acc: PoPowHeader[] = [];
  let anchor = chain[0]!;
  for (let level = maxLevel; level >= 0; level--) {
    const subChain = preSuffix.filter(
      p => maxLevelOf(p.header) >= level && p.header.height >= anchor.header.height,
    );
    if (m < subChain.length) anchor = subChain[subChain.length - m]!;
    acc.push(...subChain);
  }

  // distinct (by header id) + sort by height.
  const prefix: PoPowHeader[] = [];
  for (const p of acc) {
    if (!prefix.some(q => bytesEqual(q.header.id, p.header.id))) prefix.push(p);
  }
  prefix.sort((a, b) => a.header.height - b.header.height);

  // Task 7b: prove() only ever builds non-continuous proofs (Task 8's
  // proveWithReader does the same; continuous-mode proving is a planned
  // follow-up unit, see facts/nipopow.md "Does NOT ship").
  return { m, k, prefix, suffixHead, suffixTail, continuous: false };
}

// ── proveWithReader — JVM NipopowProverWithDbAlgs.prove port ────────────────
//
// Demand-loaded counterpart to prove(): walks the interlink graph backward
// from suffixHead through a caller-supplied PopowHeaderReader instead of
// scanning an in-memory chain array. This is the PRODUCTION prover — the
// JVM node's live proof-serving path (PopowProcessor.scala's popowProof,
// backing the GET /nipopow/proof/{m}/{k} REST endpoint) calls
// NipopowProverWithDbAlgs.prove directly, whereas prove() above ports
// NipopowAlgos.prove, which the JVM's own source marks "Paper-like code
// used in tests only" (NipopowAlgos.scala:127). The two are NOT
// byte-identical in general: on any real chain (roughly half of all blocks
// are level 0 per KMZ17) they diverge systematically, because this walk has
// no interlink position representing "level 0" at all. They DO coincide on
// fake-PoW synthetic chains such as the SANTA fixtures (verified
// level-0-free). See facts/nipopow.md "proveWithReader" for the full
// predicate and derivation. Header loads are O(m + k + m·log N), not O(N).
//
// JVM reference (canonical, clean-room behavior reference only):
// ~/projects/ergo-jvm-pr/src/main/scala/org/ergoplatform/modifiers/history/popow/NipopowProverWithDbAlgs.scala

export interface PopowHeaderReader {
  headersHeight(): Promise<number>;
  popowHeaderById(id: Uint8Array): Promise<PoPowHeader | null>;
  popowHeaderAtHeight(height: number): Promise<PoPowHeader | null>;
  lastHeaders(n: number): Promise<Header[]>;
  bestHeadersAfter(header: Header, n: number): Promise<Header[]>;
}

/** interlinks.tail reversed with level indices — JVM linksWithIndexes. */
function linksWithIndexes(ph: PoPowHeader): [Uint8Array, number][] {
  return ph.interlinks.slice(1).reverse().map((id, i) => [id, i] as [Uint8Array, number]);
}

function previousHeaderIdAtLevel(level: number, ph: PoPowHeader): Uint8Array | null {
  const found = linksWithIndexes(ph).find(([, i]) => i === level);
  return found ? found[0] : null;
}

async function requirePopowById(reader: PopowHeaderReader, id: Uint8Array): Promise<PoPowHeader> {
  const ph = await reader.popowHeaderById(id);
  if (ph === null) {
    throw new ProofBuildError('reader returned null for a required popow header (by id)', 'missing-popow-header');
  }
  return ph;
}

function bytesToHexKey(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/**
 * Compute a NiPoPoW proof by demand-loading headers through `reader`, instead
 * of scanning an in-memory chain (contrast `prove`). If `headerId` is given,
 * the result is anchored at that header (it becomes `suffixHead`) rather than
 * the reader's tip. On a level-0-free chain (e.g. the SANTA fixtures) this
 * equals `prove()` on the chain truncated just past that header; in general
 * (any real chain) the prefix is this walk's own selection, not `prove()`'s
 * — see facts/nipopow.md "proveWithReader(reader, params, headerId?)" for
 * the full contract.
 */
export async function proveWithReader(
  reader: PopowHeaderReader,
  params: PoPowParams,
  headerId?: Uint8Array,
): Promise<NipopowProof> {
  const { m, k } = params;
  if (!Number.isInteger(m) || m < 1) throw new ProofBuildError(`m must be >= 1, got ${m}`, 'invalid-m');
  if (!Number.isInteger(k) || k < 1) throw new ProofBuildError(`k must be >= 1, got ${k}`, 'invalid-k');
  const height = await reader.headersHeight();
  if (height < m + k) {
    throw new ProofBuildError(`cannot prove chain of height ${height} < m+k=${m + k}`, 'chain-too-short');
  }

  // Suffix selection (JVM: headerIdOpt match).
  let suffixHead: PoPowHeader;
  let suffixTail: Header[];
  if (headerId !== undefined) {
    suffixHead = await requirePopowById(reader, headerId);
    suffixTail = await reader.bestHeadersAfter(suffixHead.header, k - 1);
  } else {
    const suffix = await reader.lastHeaders(k);
    if (suffix.length < k) {
      throw new ProofBuildError(`reader returned ${suffix.length} < k=${k} last headers`, 'chain-too-short');
    }
    suffixHead = await requirePopowById(reader, suffix[0]!.id);
    suffixTail = suffix.slice(1);
  }

  // collectLevel: follow same-level back-pointers until below the anchor.
  async function collectLevel(startId: Uint8Array, level: number, anchoringHeight: number): Promise<PoPowHeader[]> {
    const acc: PoPowHeader[] = [];
    let nextId: Uint8Array | null = startId;
    while (nextId !== null) {
      const ph = await requirePopowById(reader, nextId);
      if (ph.header.height < anchoringHeight) break;
      acc.unshift(ph); // prepend — ascending height, JVM newAcc = prevHeader +: acc
      nextId = previousHeaderIdAtLevel(level, ph);
    }
    return acc;
  }

  // provePrefix: fold levels from highest (JVM foldRight over linksWithIndexes).
  const collected = new Map<string, PoPowHeader>(); // key: hex id
  const levels = linksWithIndexes(suffixHead);
  let anchoringHeight = 1; // genesisHeight
  for (let j = levels.length - 1; j >= 0; j--) {
    const [pointerId, levelIdx] = levels[j]!;
    const levelHeaders = await collectLevel(pointerId, levelIdx, anchoringHeight);
    for (const ph of levelHeaders) collected.set(bytesToHexKey(ph.header.id), ph);
    if (m < levelHeaders.length) {
      anchoringHeight = levelHeaders[levelHeaders.length - m]!.header.height;
    }
  }

  // Genesis always seeded; dedupe by height (JVM storedHeights).
  const genesis = await reader.popowHeaderAtHeight(1);
  if (genesis === null) {
    throw new ProofBuildError('reader returned null for genesis (height 1)', 'missing-popow-header');
  }
  const byHeight = new Map<number, PoPowHeader>();
  byHeight.set(1, genesis);
  for (const ph of collected.values()) {
    if (!byHeight.has(ph.header.height)) byHeight.set(ph.header.height, ph);
  }
  const prefix = [...byHeight.values()].sort((a, b) => a.header.height - b.header.height);

  // Task 7b: mirrors prove() — proveWithReader only ever builds
  // non-continuous proofs (see facts/nipopow.md "Does NOT ship").
  return { m, k, prefix, suffixHead, suffixTail, continuous: false };
}

// ── /prover subpath surface ──────────────────────────────────────────────────
export { updateInterlinks, unpackInterlinks, proofForInterlinkVector, makePopowHeader } from './interlinks.ts';
export { packInterlinks, MerkleTree, buildExtensionTree, type ExtensionKV, type BatchMerkleProof } from './merkle.ts';
export { maxLevelOf } from './level.ts';
export { ProofBuildError } from './errors.ts';
export type { PoPowHeader } from './popow-header.ts';
export type { NipopowProof } from './proof.ts';
