import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MerkleTree, buildExtensionTree, hashExtensionLeaf,
  serializeBatchMerkleProof, merkleRootFromLeaves, verifyBatchMerkleProof,
  type ExtensionKV,
} from '../src/merkle.ts';
import { parseProof } from '../src/proof.ts';
import { hexToBytes, bytesToHex } from './helpers.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const batchMerkle = JSON.parse(readFileSync(join(FIX, 'batch_merkle.json'), 'utf8'));
const proofFixtures = JSON.parse(readFileSync(join(FIX, 'nipopow_proof.json'), 'utf8'));

function kvsFromHexPairs(pairs: [string, string][]): ExtensionKV[] {
  return pairs.map(([k, v]) => ({ key: hexToBytes(k), value: hexToBytes(v) }));
}

describe('MerkleTree builder vs batch_merkle.json', () => {
  for (const fx of batchMerkle) {
    it(`${fx.label}: root + full-key-set proof byte-identical`, () => {
      const kvs = kvsFromHexPairs(fx.leaf_kv);
      const tree = buildExtensionTree(kvs);
      expect(bytesToHex(tree.rootHash())).toBe(fx.root_hex);
      const proof = tree.proofByIndices(kvs.map((_, i) => i));
      expect(proof).not.toBeNull();
      expect(bytesToHex(serializeBatchMerkleProof(proof!))).toBe(fx.proof_bytes_hex);
    });
  }
});

describe('MerkleTree builder vs every PoPowHeader in nipopow_proof.json', () => {
  for (const fx of proofFixtures) {
    it(`${fx.label}: rebuilt root + interlinks proof match stored`, () => {
      const parsed = parseProof(hexToBytes(fx.bytes_hex));
      const popowHeaders = [...parsed.prefix, parsed.suffixHead];
      expect(popowHeaders.length).toBe(fx.packed_leaves_per_popow_header.length);
      for (let i = 0; i < popowHeaders.length; i++) {
        const kvs = kvsFromHexPairs(fx.packed_leaves_per_popow_header[i]);
        const tree = buildExtensionTree(kvs);
        expect(bytesToHex(tree.rootHash())).toBe(fx.interlinks_roots_per_popow_header[i]);
        const proof = tree.proofByIndices(kvs.map((_, j) => j));
        expect(bytesToHex(serializeBatchMerkleProof(proof!)))
          .toBe(bytesToHex(serializeBatchMerkleProof(popowHeaders[i]!.interlinksProof)));
      }
    });
  }
});

describe('MerkleTree edge behavior', () => {
  const leaf = (n: number) => hashExtensionLeaf({ key: new Uint8Array([1, n]), value: new Uint8Array([1, n, 0]) });

  it('rootHash agrees with merkleRootFromLeaves for 1..9 leaves', () => {
    for (let n = 1; n <= 9; n++) {
      const hashes = Array.from({ length: n }, (_, i) => leaf(i));
      expect(bytesToHex(new MerkleTree(hashes).rootHash()))
        .toBe(bytesToHex(merkleRootFromLeaves(hashes)));
    }
  });

  it('proofByIndices: empty / out-of-range / duplicate index lists → null', () => {
    const tree = new MerkleTree([leaf(0), leaf(1), leaf(2)]);
    expect(tree.proofByIndices([])).toBeNull();
    expect(tree.proofByIndices([3])).toBeNull();
    expect(tree.proofByIndices([1, 1])).toBeNull();
    expect(tree.proofByIndices([-1])).toBeNull();
  });

  it('subset proofs across shapes verify against the root (verify-side cross-check)', () => {
    for (let n = 1; n <= 9; n++) {
      const kvs: ExtensionKV[] = Array.from({ length: n }, (_, i) =>
        ({ key: new Uint8Array([1, i]), value: new Uint8Array([1, i, 7]) }));
      const tree = buildExtensionTree(kvs);
      for (let i = 0; i < n; i++) {
        const p = tree.proofByIndices([i]);
        expect(p).not.toBeNull();
        // verifyBatchMerkleProof takes the FULL leaf array (it indexes by
        // position) and validates the reconstructed root.
        expect(verifyBatchMerkleProof(p!, kvs, tree.rootHash())).toBe(true);
      }
    }
  });

  it('tampered leaf changes the root', () => {
    const a = new MerkleTree([leaf(0), leaf(1)]).rootHash();
    const b = new MerkleTree([leaf(0), leaf(2)]).rootHash();
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});
