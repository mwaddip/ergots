/**
 * Interlink-vector maintenance — construction-side counterpart of the
 * verifier's packInterlinks/checkInterlinksProof.
 *
 * JVM reference (canonical): NipopowAlgos.scala — updateInterlinks,
 * unpackInterlinks, proofForInterlinkVector; ExtensionCandidate.batchProofFor.
 * Second reading: sigma-rust ergo-nipopow/src/nipopow_algos.rs.
 */
import type { Header } from '@ergots/scorex';
import { maxLevelOf } from './level.ts';
import {
  packInterlinks, buildExtensionTree,
  type ExtensionKV, type BatchMerkleProof,
} from './merkle.ts';
import type { PoPowHeader } from './popow-header.ts';
import { ProofBuildError } from './errors.ts';

const INTERLINK_VECTOR_PREFIX = 0x01;
const INTERLINK_VALUE_LEN = 33; // 1-byte qty + 32-byte block id

/**
 * Interlinks vector for the block AFTER prevHeader.
 * Genesis: [prevHeader.id]. Level L > 0: keep genesis, drop the last L tail
 * entries, append prevHeader.id ×L (grows past the old length when
 * L >= tail.length). Level <= 0: contents unchanged (fresh array).
 */
export function updateInterlinks(prevHeader: Header, prevInterlinks: Uint8Array[]): Uint8Array[] {
  if (prevHeader.height === 1) return [prevHeader.id.slice()];
  if (prevInterlinks.length === 0) {
    throw new ProofBuildError(
      'interlinks vector cannot be empty for a non-genesis header',
      'empty-interlinks',
    );
  }
  const prevLevel = maxLevelOf(prevHeader);
  if (prevLevel <= 0) return prevInterlinks.slice();
  const genesis = prevInterlinks[0]!;
  const tail = prevInterlinks.slice(1);
  const kept = tail.slice(0, Math.max(0, tail.length - prevLevel));
  const out = [genesis, ...kept];
  for (let i = 0; i < prevLevel; i++) out.push(prevHeader.id);
  return out;
}

/**
 * Inverse of packInterlinks: expand [qty, blockId] interlink-prefixed fields,
 * in field order. Non-interlink keys are ignored.
 * @throws ProofBuildError('malformed-interlinks') on a value length !== 33.
 */
export function unpackInterlinks(fields: ExtensionKV[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const { key, value } of fields) {
    if (key.length === 0 || key[0] !== INTERLINK_VECTOR_PREFIX) continue;
    if (value.length !== INTERLINK_VALUE_LEN) {
      throw new ProofBuildError(
        `interlink field value must be 33 bytes, got ${value.length}`,
        'malformed-interlinks',
      );
    }
    const qty = value[0]!;
    const id = value.slice(1);
    for (let i = 0; i < qty; i++) out.push(id);
  }
  return out;
}

/**
 * BatchMerkleProof over the interlinks-only tree for ALL interlink-prefixed
 * keys, in field order. Zero interlink fields → empty proof (JVM
 * BatchMerkleProof(Seq.empty, Seq.empty)).
 */
export function proofForInterlinkVector(fields: ExtensionKV[]): BatchMerkleProof {
  const interlinkFields = fields.filter(f => f.key.length > 0 && f.key[0] === INTERLINK_VECTOR_PREFIX);
  if (interlinkFields.length === 0) return { indices: [], proofs: [] };
  const tree = buildExtensionTree(interlinkFields);
  const proof = tree.proofByIndices(interlinkFields.map((_, i) => i));
  // Full in-range index set over a non-empty tree cannot fail.
  return proof!;
}

/** packInterlinks → proofForInterlinkVector → PoPowHeader. */
export function makePopowHeader(header: Header, interlinks: Uint8Array[]): PoPowHeader {
  const fields = packInterlinks(interlinks);
  return { header, interlinks, interlinksProof: proofForInterlinkVector(fields) };
}
