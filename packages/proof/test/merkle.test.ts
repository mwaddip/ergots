import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseBatchMerkleProof, verifyBatchMerkleProof } from '../src/merkle';
import { ByteReader } from '../src/scorex/reader';
import { hexToBytes } from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface MerkleCase {
  label: string;
  leaf_kv: [string, string][];
  root_hex: string;
  proof_bytes_hex: string;
}
const fixtures: MerkleCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/batch_merkle.json'), 'utf8')
);

describe('BatchMerkleProof', () => {
  for (const c of fixtures) {
    test(`${c.label}: parse + verify against root`, () => {
      const r = new ByteReader(hexToBytes(c.proof_bytes_hex));
      const proof = parseBatchMerkleProof(r);
      const leaves = c.leaf_kv.map(([k, v]) => ({
        key: hexToBytes(k),
        value: hexToBytes(v),
      }));
      expect(verifyBatchMerkleProof(proof, leaves, hexToBytes(c.root_hex))).toBe(true);
    });
  }

  test('empty proof verifies vacuously (no interlinks case)', () => {
    // An empty BatchMerkleProof (indices=[], proofs=[]) is used when interlinks is empty.
    // The check in check_interlinks_proof short-circuits before calling valid().
    // We model this: parseBatchMerkleProof of an empty proof (8 zero bytes).
    const emptyProofBytes = new Uint8Array(8); // [0,0,0,0, 0,0,0,0]
    const r = new ByteReader(emptyProofBytes);
    const proof = parseBatchMerkleProof(r);
    expect(proof.indices).toHaveLength(0);
    expect(proof.proofs).toHaveLength(0);
  });
});
