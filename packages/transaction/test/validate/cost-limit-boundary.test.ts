// SANTA JVM-blessed boundary pair over testnet tx multi-input-3 (h402800, cost 18415).
// accept@18415 + reject@18414 together pin the exact tx cost = 18415 block.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ByteReader, parseHeader } from '@ergots/scorex';
import type { Header } from '@ergots/scorex';
import { parseSValue } from '@ergots/ergoscript';
import type { ErgoBox, PreHeader } from '@ergots/ergoscript';

import { parseTransaction } from '../../src/index.ts';
import { validateStateful } from '../../src/validate/stateful';
import { TxValidationError } from '../../src/errors';
import type { ChainParameters } from '../../src/types.ts';

const hexToBytes = (h: string): Uint8Array => {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
};
const parseBox = (h: string): ErgoBox => {
  const sv = parseSValue({ tag: 'SBox' }, 0, new ByteReader(hexToBytes(h)));
  if (sv.kind !== 'Box') throw new Error(`parseSValue kind=${sv.kind}, expected Box`);
  return sv.value;
};

interface Entry {
  name: string;
  tx_bytes_hex: string;
  input_boxes_hex: string[];
  data_input_boxes_hex: string[];
  headers_hex: string[];
  preHeader: { version: number; parentId: string; timestamp: string; nBits: number; height: number; minerPk: string; votes: string };
  parameters: ChainParameters;
}

const vectorPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'conformance', 'cost-limit-boundary.json',
);
const vector = JSON.parse(fs.readFileSync(vectorPath, 'utf8')) as { entries: Entry[] };
const entry = (name: string): Entry => {
  const e = vector.entries.find((x) => x.name === name);
  if (!e) throw new Error(`entry ${name} not found`);
  return e;
};

function depsFor(e: Entry) {
  const tx = parseTransaction(hexToBytes(e.tx_bytes_hex));
  const inputBoxes = e.input_boxes_hex.map(parseBox);
  const dataInputBoxes = e.data_input_boxes_hex.map(parseBox);
  const headers: Header[] = e.headers_hex.map((h) => parseHeader(new ByteReader(hexToBytes(h))));
  const ph = e.preHeader;
  const preHeader: PreHeader = {
    version: ph.version, parentId: hexToBytes(ph.parentId), timestamp: BigInt(ph.timestamp),
    nBits: ph.nBits, height: ph.height, minerPk: hexToBytes(ph.minerPk), votes: hexToBytes(ph.votes),
  };
  return { tx, deps: { inputBoxes, dataInputBoxes, stateContext: { headers, preHeader, parameters: e.parameters } } };
}

describe('SANTA cost-limit-boundary (jvm-blessed) — sigma-verification cost', () => {
  it('cost-limit-accept (maxBlockCost=18415) validates', () => {
    const { tx, deps } = depsFor(entry('cost-limit-accept'));
    expect(() => validateStateful(tx, deps)).not.toThrow();
  });

  it('cost-limit-reject (maxBlockCost=18414) rejects with cost-limit-exceeded', () => {
    const { tx, deps } = depsFor(entry('cost-limit-reject'));
    let err: unknown;
    try { validateStateful(tx, deps); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TxValidationError);
    expect((err as TxValidationError).code).toBe('cost-limit-exceeded');
  });
});
