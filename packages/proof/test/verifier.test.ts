import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { verifyProof, verifyParsedProof } from '../src/verifier.ts';
import { ProofVerificationError } from '../src/errors.ts';
import { ProofParseError } from '../src/errors.ts';
import type { NipopowProof } from '../src/proof.ts';
import type { PoPowHeader } from '../src/popow-header.ts';
import type { Header } from '../src/header.ts';
import { hexToBytes } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ConnectionMutation {
  label: string;
  mutated_bytes_hex: string;
  expected_valid: boolean;
}

interface ProofCase {
  label: string;
  bytes_hex: string;
  prefix_heights: number[];
  suffix_head_height: number;
  suffix_tail_heights: number[];
  connection_mutations?: ConnectionMutation[];
}

const fixtures: ProofCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/nipopow_proof.json'), 'utf8')
);

// ─────────────────────────────────────────────────────────────────────────────
// Positive cases: all 4 synthetic fixtures verify with checkPoW: false
// (Synthetic headers have trivial PoW nonces that don't satisfy the target;
// checkPoW: false bypasses that path entirely.)
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyProof: positive cases (checkPoW: false)', () => {
  for (const c of fixtures) {
    test(`${c.label}: verifies and returns correct counts/heights`, () => {
      const result = verifyProof(hexToBytes(c.bytes_hex), { checkPoW: false });

      const expectedTotal = c.prefix_heights.length + 1 + c.suffix_tail_heights.length;
      expect(result.totalHeaders).toBe(expectedTotal);

      const expectedTipHeight =
        c.suffix_tail_heights.length > 0
          ? c.suffix_tail_heights[c.suffix_tail_heights.length - 1]!
          : c.suffix_head_height;
      expect(result.suffixTipHeight).toBe(expectedTipHeight);

      expect(result.continuous).toBe(false);
      expect(result.headers).toHaveLength(expectedTotal);

      // Heights must be strictly increasing
      const heights = result.headers.map(h => h.height);
      for (let i = 1; i < heights.length; i++) {
        expect(heights[i]!).toBeGreaterThan(heights[i - 1]!);
      }

      // Last header height matches suffixTipHeight
      expect(result.headers[result.headers.length - 1]!.height).toBe(result.suffixTipHeight);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error-mode tests: malformed / empty / oversized bytes throw parse-failed
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyProof: error modes', () => {
  test('throws ProofVerificationError(parse-failed) on empty bytes', () => {
    try {
      verifyProof(new Uint8Array(0));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('parse-failed');
    }
  });

  test('throws ProofVerificationError(parse-failed) on oversized input', () => {
    try {
      verifyProof(new Uint8Array(2_000_001));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('parse-failed');
    }
  });

  test('throws ProofVerificationError(parse-failed) on truncated bytes', () => {
    // Take the first fixture and truncate to 10 bytes — definitely invalid
    const truncated = hexToBytes(fixtures[0]!.bytes_hex).slice(0, 10);
    try {
      verifyProof(truncated);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('parse-failed');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connection-mutation tests: every connection mutation is rejected with
// 'invalid-connections'
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyProof: connection mutations throw invalid-connections', () => {
  for (const c of fixtures) {
    for (const m of c.connection_mutations ?? []) {
      test(`${c.label} / ${m.label}: rejected with invalid-connections`, () => {
        try {
          verifyProof(hexToBytes(m.mutated_bytes_hex), { checkPoW: false });
          throw new Error('expected throw');
        } catch (e) {
          expect(e).toBeInstanceOf(ProofVerificationError);
          expect((e as ProofVerificationError).code).toBe('invalid-connections');
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic helpers for verifyParsedProof tests
// (mirror of the pattern in connections.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic id: byte 0 = i & 0xff, byte 1 = (i >>> 8) & 0xff, rest zeros. */
function makeId(i: number): Uint8Array {
  const out = new Uint8Array(32);
  out[0] = i & 0xff;
  out[1] = (i >>> 8) & 0xff;
  return out;
}

/** Minimal Header with only id, parentId, and height set (others are inert here). */
function makeSyntheticHeader(id: Uint8Array, parentId: Uint8Array, height: number): Header {
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
function makePoPowHeader(id: Uint8Array, parentId: Uint8Array, height: number): PoPowHeader {
  return {
    header: makeSyntheticHeader(id, parentId, height),
    interlinks: [],
    interlinksProof: { indices: [], proofs: [] },
  };
}

/**
 * Build a minimal NipopowProof from a list of prefix heights + a suffix-head height.
 * Each consecutive header has its parentId set to the previous header's id so that
 * hasValidConnections passes. Heights come from the caller (may be non-monotonic).
 */
function buildSyntheticProof(prefixHeights: number[], suffixHeadHeight: number): NipopowProof {
  // Assign sequential numeric ids starting from 1 so they are non-zero and distinct.
  let nextId = 1;

  const prefix: PoPowHeader[] = [];
  let prevId = makeId(0); // genesis parent
  for (const h of prefixHeights) {
    const id = makeId(nextId++);
    prefix.push(makePoPowHeader(id, prevId, h));
    prevId = id;
  }

  const suffixHeadId = makeId(nextId++);
  const suffixHead = makePoPowHeader(suffixHeadId, prevId, suffixHeadHeight);

  return { m: 0, k: 0, prefix, suffixHead, suffixTail: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyParsedProof: non-increasing-heights
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyParsedProof: non-increasing-heights', () => {
  test('throws ProofVerificationError(non-increasing-heights) when two adjacent prefix heights are equal', () => {
    // Heights [10, 10, 20]: prefix[0]=10, prefix[1]=10 — equal, not strictly increasing
    const proof = buildSyntheticProof([10, 10], 20);
    try {
      verifyParsedProof(proof, { checkPoW: false });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('non-increasing-heights');
    }
  });

  test('throws ProofVerificationError(non-increasing-heights) when prefix height decreases', () => {
    // Heights [10, 5, 20]: prefix[0]=10, prefix[1]=5 — decreasing
    const proof = buildSyntheticProof([10, 5], 20);
    try {
      verifyParsedProof(proof, { checkPoW: false });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('non-increasing-heights');
    }
  });

  test('throws ProofVerificationError(non-increasing-heights) when suffix-head height is not above last prefix', () => {
    // Heights [10, 20] prefix, then suffixHead height=15 — not above prefix[last]=20
    const proof = buildSyntheticProof([10, 20], 15);
    try {
      verifyParsedProof(proof, { checkPoW: false });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('non-increasing-heights');
    }
  });

  test('does NOT throw when heights are strictly increasing', () => {
    const proof = buildSyntheticProof([5, 10, 15], 20);
    const result = verifyParsedProof(proof, { checkPoW: false });
    expect(result.totalHeaders).toBe(4); // 3 prefix + 1 suffixHead
    expect(result.suffixTipHeight).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyParsedProof: empty-proof branch is dead code
//
// The 'empty-proof' error code is defensive dead code: NipopowProof always has
// at least one header (suffixHead), so allHeaders.length is always >= 1 for any
// proof returned by parseProof. This test asserts that a proof with empty prefix
// and empty suffix_tail still yields totalHeaders === 1, confirming the branch
// cannot be reached through the normal parseProof → verifyParsedProof path.
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyParsedProof: empty-proof branch is unreachable', () => {
  test('empty prefix + empty suffix_tail yields totalHeaders === 1 (not zero)', () => {
    const proof = buildSyntheticProof([], 42);
    // No prefix, no suffixTail — just suffixHead; should verify cleanly.
    const result = verifyParsedProof(proof, { checkPoW: false });
    expect(result.totalHeaders).toBe(1);
    expect(result.suffixTipHeight).toBe(42);
    expect(result.continuous).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parse-failed cause chain
//
// Verify that the ProofVerificationError wrapping a parse failure preserves the
// original ProofParseError as its `.cause` (ES2022 error chaining).
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyProof: parse-failed preserves cause chain', () => {
  test('ProofVerificationError.cause is the original ProofParseError', () => {
    try {
      verifyProof(new Uint8Array(0));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('parse-failed');
      // The cause must be the original ProofParseError — not undefined or another type.
      expect((e as ProofVerificationError).cause).toBeInstanceOf(ProofParseError);
    }
  });

  test('ProofVerificationError.cause preserves the original parse error code', () => {
    const truncated = hexToBytes(fixtures[0]!.bytes_hex).slice(0, 10);
    try {
      verifyProof(truncated);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      const cause = (e as ProofVerificationError).cause;
      expect(cause).toBeInstanceOf(ProofParseError);
      // The original parse error code (truncated / oversized / empty-proof etc.) is preserved.
      expect(typeof (cause as ProofParseError).code).toBe('string');
      expect((cause as ProofParseError).code.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real mainnet proof: checkPoW: true end-to-end
//
// A real mainnet NiPoPoW proof is needed to exercise verifyProof with the
// default checkPoW: true path. The local ergo-node-rust at port 9052 does NOT
// expose a /nipopow/proof endpoint (returns HTTP 404), so no live proof could
// be captured at development time.
//
// This test is skipped until a real proof fixture is added:
//   1. Add a REST endpoint to ergo-node-rust (Task 17 scope)
//   2. Capture: curl http://localhost:9052/nipopow/proof/2/2 | <parse + hex-encode>
//   3. Write bytes_hex into fixtures/nipopow_proof.json with label "mainnet-real-*"
//      and is_real_proof: true
//   4. Remove test.skip below
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyProof: real mainnet proof with checkPoW: true', () => {
  test.skip('mainnet real proof verifies end-to-end with checkPoW: true (default)', () => {
    // Find the first fixture labelled as a real proof.
    const c = (fixtures as Array<ProofCase & { is_real_proof?: boolean }>).find(
      f => f.is_real_proof === true || f.label.startsWith('mainnet-real'),
    );
    if (!c) {
      throw new Error(
        'No real mainnet proof fixture found. ' +
        'See comment above this test for capture instructions.',
      );
    }
    // Default opts: checkPoW: true — exercises the full Autolykos v2 path.
    const result = verifyProof(hexToBytes(c.bytes_hex));
    expect(result.totalHeaders).toBeGreaterThan(0);
    expect(result.continuous).toBe(false);
    // Tip height should be a plausible mainnet height (> 1_000_000 as of 2025).
    expect(result.suffixTipHeight).toBeGreaterThan(1_000_000);
  });
});
