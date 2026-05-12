import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { hasValidConnections } from '../src/connections.ts';
import { parseProof } from '../src/proof.ts';
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
        expect(hasValidConnections(proof)).toBe(m.expected_valid);
      });
    }
  }
});
