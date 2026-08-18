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

// ── /prover subpath surface ──────────────────────────────────────────────────
export { updateInterlinks, unpackInterlinks, proofForInterlinkVector, makePopowHeader } from './interlinks.ts';
export { packInterlinks, MerkleTree, buildExtensionTree, type ExtensionKV, type BatchMerkleProof } from './merkle.ts';
export { maxLevelOf } from './level.ts';
export { ProofBuildError } from './errors.ts';
export type { PoPowHeader } from './popow-header.ts';
export type { NipopowProof } from './proof.ts';
