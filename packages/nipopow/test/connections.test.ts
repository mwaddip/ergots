import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { hasValidConnections } from '../src/connections.ts';
import { parseProof } from '../src/proof.ts';
import { hexToBytes } from './helpers.ts';
import type { NipopowProof } from '../src/proof.ts';
import type { PoPowHeader } from '../src/popow-header.ts';
import type { Header } from '@ergots/scorex';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ConnectionMutation {
  label: string;
  mutated_bytes_hex: string;
  expected_valid: boolean;
}

interface ProofCase {
  label: string;
  bytes_hex: string;
  connection_mutations: ConnectionMutation[];
}

const fixtures: ProofCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/nipopow_proof.json'), 'utf8')
);

describe('hasValidConnections', () => {
  for (const c of fixtures) {
    test(`${c.label}: genuine proof has valid connections`, () => {
      const proof = parseProof(hexToBytes(c.bytes_hex));
      expect(hasValidConnections(proof)).toBe(true);
    });

    for (const m of c.connection_mutations ?? []) {
      test(`${c.label} / ${m.label}: mutated proof has INVALID connections`, () => {
        const proof = parseProof(hexToBytes(m.mutated_bytes_hex));
        // Mutations are always intended to break linkage; assert directly.
        expect(hasValidConnections(proof)).toBe(false);
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic helpers for boundary tests
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic synthetic id: byte 0 = i & 0xff, byte 1 = (i >>> 8) & 0xff, rest zeros. */
function makeId(i: number): Uint8Array {
  const out = new Uint8Array(32);
  out[0] = i & 0xff;
  out[1] = (i >>> 8) & 0xff;
  return out;
}

/**
 * Construct a minimal synthetic Header. hasValidConnections only reads
 * header.id and header.parentId — all other fields are inert for this test.
 */
function makeSyntheticHeader(id: Uint8Array, parentId: Uint8Array): Header {
  return {
    version: 2,
    id,
    parentId,
    adProofsRoot: new Uint8Array(32),
    transactionRoot: new Uint8Array(32),
    stateRoot: new Uint8Array(33),
    timestamp: 0,
    nBits: 0,
    height: 0,
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

/**
 * Construct a minimal synthetic PoPowHeader. hasValidConnections reads
 * header.id, header.parentId, and interlinks — interlinksProof is not touched.
 */
function makePoPowHeader(id: Uint8Array, parentId: Uint8Array): PoPowHeader {
  return {
    header: makeSyntheticHeader(id, parentId),
    interlinks: [],
    interlinksProof: { indices: [], proofs: [] },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Boundary tests
// ─────────────────────────────────────────────────────────────────────────────

describe('hasValidConnections boundary cases', () => {
  test('empty prefix returns true (vacuous)', () => {
    const proof: NipopowProof = {
      m: 0, k: 0,
      prefix: [],
      suffixHead: makePoPowHeader(makeId(0), makeId(99)),
      suffixTail: [],
    };
    expect(hasValidConnections(proof)).toBe(true);
  });

  test('single-entry prefix with parent-id link to suffixHead returns true', () => {
    // prefix[0].id = 1; suffixHead.parentId = 1 (linked via parent-id match)
    const proof: NipopowProof = {
      m: 0, k: 0,
      prefix: [makePoPowHeader(makeId(1), makeId(0))],
      suffixHead: makePoPowHeader(makeId(2), makeId(1)),
      suffixTail: [],
    };
    expect(hasValidConnections(proof)).toBe(true);
  });

  test('single-entry prefix with NO link to suffixHead returns false', () => {
    // prefix[0].id = 1; suffixHead.parentId = 99 (NOT linked); interlinks empty
    const proof: NipopowProof = {
      m: 0, k: 0,
      prefix: [makePoPowHeader(makeId(1), makeId(0))],
      suffixHead: makePoPowHeader(makeId(2), makeId(99)),
      suffixTail: [],
    };
    expect(hasValidConnections(proof)).toBe(false);
  });

  test('11-entry prefix chained via parent-id at LOOKBACK_SPAN boundary returns true', () => {
    // 11 entries chained: prefix[i].parentId = prefix[i-1].id
    const prefix: PoPowHeader[] = [];
    for (let i = 0; i < 11; i++) {
      prefix.push(makePoPowHeader(makeId(i + 1), makeId(i)));
    }
    const suffixHead = makePoPowHeader(makeId(12), makeId(11));
    const proof: NipopowProof = {
      m: 0, k: 0,
      prefix,
      suffixHead,
      suffixTail: [],
    };
    expect(hasValidConnections(proof)).toBe(true);
  });
});
