import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseProof } from '../src/proof.ts';
import { hexToBytes } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ProofCase {
  label: string;
  m: number;
  k: number;
  chain_size: number;
  anchor: string | null;
  prefix_heights: number[];
  suffix_head_height: number;
  suffix_tail_heights: number[];
  bytes_hex: string;
  packed_leaves_per_popow_header: [string, string][][];
  interlinks_roots_per_popow_header: string[];
}

const fixtures: ProofCase[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/nipopow_proof.json'), 'utf8')
);

describe('NipopowProof parse', () => {
  for (const c of fixtures) {
    test(`${c.label}: m=${c.m}, k=${c.k} parses with expected heights`, () => {
      const proof = parseProof(hexToBytes(c.bytes_hex));
      expect(proof.m).toBe(c.m);
      expect(proof.k).toBe(c.k);
      expect(proof.prefix.map(p => p.header.height)).toEqual(c.prefix_heights);
      expect(proof.suffixHead.header.height).toBe(c.suffix_head_height);
      expect(proof.suffixTail.map(h => h.height)).toEqual(c.suffix_tail_heights);
    });
  }
});
