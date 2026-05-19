/**
 * Interlink Merkle proof verification (Codex audit Finding #1, HIGH).
 *
 * verifyProof must call checkInterlinksProof per PoPowHeader (suffixHead + every
 * prefix entry). Before this fix, mutating a real proof's `interlinksProof` hash
 * (or any interlink byte) and reserializing → verifyProof still returned success.
 *
 * Sigma-rust parity: ergo-nipopow PoPowHeader::check_interlinks_proof.
 * KNOWN LIMITATION (shared with sigma-rust): the check validates against a
 * Merkle root computed from interlinks-only, NOT from header.extensionRoot.
 * This enforces internal proof consistency but does NOT anchor to the on-chain
 * extension commitment. See facts/nipopow.md Known Limitations.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseProof, serializeProof } from '../src/proof.ts';
import { verifyProof } from '../src/verifier.ts';
import { ProofVerificationError } from '../src/errors.ts';
import { hexToBytes } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'fixtures/nipopow_proof.json');
const corpus = JSON.parse(readFileSync(fixturePath, 'utf8')) as { label: string; bytes_hex: string }[];

// chain-20-m2-k2-tip is the smallest synthetic fixture; its proof was generated
// from an interlinks-only ExtensionCandidate so check_interlinks_proof's "compute
// root from interlinks-only leaves" approach works without anchoring.
const fixture = corpus.find(c => c.label === 'chain-20-m2-k2-tip')!;
const validBytes = hexToBytes(fixture.bytes_hex);

describe('verifyProof: interlink Merkle proof per PoPowHeader (Codex audit Finding #1)', () => {
  test('accepts an unmodified valid proof', () => {
    // checkPoW: false isolates this test to the interlinks-proof check —
    // the synthetic fixture has placeholder PoW that wouldn't validate anyway.
    const result = verifyProof(validBytes, { checkPoW: false });
    expect(result.totalHeaders).toBeGreaterThan(0);
  });

  test('rejects proof where suffixHead.interlinks[1] is mutated', () => {
    const parsed = parseProof(validBytes);
    expect(parsed.suffixHead.interlinks.length).toBeGreaterThan(1);
    // Mutate the first byte of the second interlink (non-genesis).
    // After serialize/parse the proof's stored leaf-hash indices remain
    // unchanged from the original; recomputed leaves from mutated interlinks
    // will differ → checkInterlinksProof must reject.
    const mutated = new Uint8Array(parsed.suffixHead.interlinks[1]!);
    mutated[0] = (mutated[0]! ^ 0xFF) & 0xFF;
    parsed.suffixHead.interlinks[1] = mutated;
    const reserialized = serializeProof(parsed);
    expect(() => verifyProof(reserialized, { checkPoW: false }))
      .toThrow(ProofVerificationError);
  });

  test('rejects proof where suffixHead.interlinksProof.indices[0].hash is mutated', () => {
    const parsed = parseProof(validBytes);
    expect(parsed.suffixHead.interlinksProof.indices.length).toBeGreaterThan(0);
    // Mutate the first stored leaf-hash. The walk-up uses this hash, so the
    // computed root will diverge from merkleRootFromLeaves(packInterlinks(...)).
    const idx = parsed.suffixHead.interlinksProof.indices[0]!;
    idx.hash[0] = (idx.hash[0]! ^ 0xFF) & 0xFF;
    const reserialized = serializeProof(parsed);
    expect(() => verifyProof(reserialized, { checkPoW: false }))
      .toThrow(ProofVerificationError);
  });
});
