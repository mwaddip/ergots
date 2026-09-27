/**
 * Loader for SANTA `santa-transaction/v1` vectors (JVM-blessed `validateStateful` verdicts and
 * block costs), copied verbatim under test/fixtures/conformance/. Test-only; never imported by src/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ByteReader, parseHeader } from '@ergots/scorex';
import { parseSValue } from '@ergots/ergoscript';
import type { ErgoBox } from '@ergots/ergoscript';

import { parseTransaction } from '../../src/index.ts';
import type { ChainParameters, ErgoLikeTransaction, StatefulDeps } from '../../src/index.ts';
import { hexToBytes } from '../_helpers';

export interface SantaTxEntry {
  name: string;
  tx_bytes_hex: string;
  input_boxes_hex: string[];
  data_input_boxes_hex: string[];
  headers_hex: string[];
  preHeader: { version: number; parentId: string; timestamp: string; nBits: number; height: number; minerPk: string; votes: string };
  parameters: ChainParameters;
  /** The JVM's verdict: an accept carries its block cost, a reject the oracle's reason. */
  expected: { valid: boolean; cost: number | null; reason: string | null };
}

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'conformance');

export function loadSantaTxEntries(file: string): SantaTxEntry[] {
  return (JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as { entries: SantaTxEntry[] }).entries;
}

function parseBox(h: string): ErgoBox {
  const sv = parseSValue({ tag: 'SBox' }, 0, new ByteReader(hexToBytes(h)));
  if (sv.kind !== 'Box') throw new Error(`parseSValue kind=${sv.kind}, expected Box`);
  return sv.value;
}

/** The entry's transaction and `validateStateful` deps. `parameters` replaces the entry's own
 *  (for `maxBlockCost` boundary pairs). */
export function santaTxInputs(
  e: SantaTxEntry,
  parameters: ChainParameters = e.parameters,
): { tx: ErgoLikeTransaction; deps: StatefulDeps } {
  const ph = e.preHeader;
  return {
    tx: parseTransaction(hexToBytes(e.tx_bytes_hex)),
    deps: {
      inputBoxes: e.input_boxes_hex.map(parseBox),
      dataInputBoxes: e.data_input_boxes_hex.map(parseBox),
      stateContext: {
        headers: e.headers_hex.map((h) => parseHeader(new ByteReader(hexToBytes(h)))),
        preHeader: {
          version: ph.version, parentId: hexToBytes(ph.parentId), timestamp: BigInt(ph.timestamp),
          nBits: ph.nBits, height: ph.height, minerPk: hexToBytes(ph.minerPk), votes: hexToBytes(ph.votes),
        },
        parameters,
      },
    },
  };
}
