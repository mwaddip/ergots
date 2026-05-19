import type { Header } from '@ergots/scorex';
import type { PoPowHeader } from '../src/popow-header.ts';
import type { NipopowProof } from '../src/proof.ts';

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0);
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(x => x.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic proof builders — shared between verifier.test.ts and proof.test.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic id: byte 0 = i & 0xff, byte 1 = (i >>> 8) & 0xff, rest zeros. */
export function makeId(i: number): Uint8Array {
  const out = new Uint8Array(32);
  out[0] = i & 0xff;
  out[1] = (i >>> 8) & 0xff;
  return out;
}

/** Minimal Header with only id, parentId, and height set (others are inert here). */
export function makeSyntheticHeader(id: Uint8Array, parentId: Uint8Array, height: number): Header {
  return {
    version: 2,
    id,
    parentId,
    adProofsRoot: new Uint8Array(32),
    transactionRoot: new Uint8Array(32),
    stateRoot: new Uint8Array(33),
    timestamp: 0,
    nBits: 0,
    height,
    extensionRoot: new Uint8Array(32),
    autolykosSolution: {
      minerPk: new Uint8Array(33),
      powOnetimePk: null,
      nonce: new Uint8Array(8),
      powDistance: null,
    },
    votes: new Uint8Array(3),
    unparsedBytes: new Uint8Array(0),
  };
}

/** Minimal PoPowHeader with only header set (interlinks + proof are empty/vacuous). */
export function makePoPowHeader(id: Uint8Array, parentId: Uint8Array, height: number): PoPowHeader {
  return {
    header: makeSyntheticHeader(id, parentId, height),
    interlinks: [],
    interlinksProof: { indices: [], proofs: [] },
  };
}

export interface SyntheticProofOptions {
  /** Prefix-header heights. Empty array → empty prefix (may violate NIP-04 shape). */
  prefixHeights: number[];
  /** Height of the suffix-head PoPowHeader. */
  suffixHeadHeight: number;
  /** Heights for suffix-tail Headers. Empty by default. */
  suffixTailHeights?: number[];
  /** Override `m` field; default 0 (legacy callers may rely on this; for valid-shape proofs use ≥1). */
  m?: number;
  /** Override `k` field; default 0 (legacy callers may rely on this; for valid-shape proofs use ≥1). */
  k?: number;
}

/**
 * Build a NipopowProof from a list of heights with consistent parent-id linkage.
 * The default {m:0, k:0} matches legacy verifier.test.ts behavior; pass m≥1 and
 * k≥1 (and a matching suffixTailHeights length === k-1) for a NIP-04-valid shape.
 */
export function buildSyntheticProof(opts: SyntheticProofOptions): NipopowProof {
  let nextId = 1;

  const prefix: PoPowHeader[] = [];
  let prevId = makeId(0);
  for (const h of opts.prefixHeights) {
    const id = makeId(nextId++);
    prefix.push(makePoPowHeader(id, prevId, h));
    prevId = id;
  }

  const suffixHeadId = makeId(nextId++);
  const suffixHead = makePoPowHeader(suffixHeadId, prevId, opts.suffixHeadHeight);
  prevId = suffixHeadId;

  const suffixTail: Header[] = [];
  for (const h of opts.suffixTailHeights ?? []) {
    const id = makeId(nextId++);
    suffixTail.push(makeSyntheticHeader(id, prevId, h));
    prevId = id;
  }

  return {
    m: opts.m ?? 1,
    k: opts.k ?? 1,
    prefix,
    suffixHead,
    suffixTail,
  };
}
