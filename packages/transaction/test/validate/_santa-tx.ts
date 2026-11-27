/**
 * Loader for SANTA `santa-transaction/v1` vectors (JVM-blessed `validateStateful` verdicts and
 * block costs). `loadSantaTxEntries` reads a file under test/fixtures/conformance/;
 * `santaTxInputs` builds the ergots deps from an entry object (inline or loaded). Test-only;
 * never imported by src/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ByteReader, parseHeader } from '@ergots/scorex';
import { parseSValue } from '@ergots/ergoscript';
import type { ErgoBox } from '@ergots/ergoscript';

import { parseTransaction, blockVersionContext } from '../../src/index.ts';
import type { ChainParameters, ErgoLikeTransaction, StatefulDeps } from '../../src/index.ts';
import { hexToBytes } from '../_helpers';

export interface SantaTxEntry {
  name: string;
  tx_bytes_hex: string;
  input_boxes_hex: string[];
  data_input_boxes_hex: string[];
  headers_hex: string[];
  preHeader: { version: number; parentId: string; timestamp: string; nBits: number; height: number; minerPk: string; votes: string };
  /** The entry's chain parameters. `blockVersion` is set by SANTA on entries that pin a voted
   *  version apart from the pre-header's; otherwise SANTA's engine falls back to the pre-header's
   *  version, as `santaTxInputs` does. */
  parameters: Omit<ChainParameters, 'blockVersion'> & { blockVersion?: number };
  /** The JVM's verdict: an accept carries its block cost, a reject the oracle's reason. */
  expected: { valid: boolean; cost: number | null; reason: string | null };
}

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'conformance');

export function loadSantaTxEntries(file: string): SantaTxEntry[] {
  return (JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as { entries: SantaTxEntry[] }).entries;
}

/** A UTXO box is read outside any version context (ergo UtxoStateReader.scala:122-130): tree
 *  version 1, no activated version on the reader. */
function parseBox(h: string): ErgoBox {
  const sv = parseSValue({ tag: 'SBox' }, 1, new ByteReader(hexToBytes(h)));
  if (sv.kind !== 'Box') throw new Error(`parseSValue kind=${sv.kind}, expected Box`);
  return sv.value;
}

/** The entry's transaction and `validateStateful` deps. The transaction is parsed under
 *  `blockVersionContext(e.parameters.blockVersion ?? e.preHeader.version)`, as SANTA's engine
 *  does and the runner's transaction arm does. An override replaces the entry's own parameters
 *  (for `maxBlockCost` boundary pairs); when it carries no `blockVersion` the entry's one is
 *  threaded through. */
export function santaTxInputs(
  e: SantaTxEntry,
  parameters?: Partial<ChainParameters>,
): { tx: ErgoLikeTransaction; deps: StatefulDeps } {
  const ph = e.preHeader;
  const bv = e.parameters.blockVersion ?? ph.version;
  const effective: ChainParameters = parameters === undefined
    ? { ...e.parameters, blockVersion: bv }
    : { ...e.parameters, ...parameters, blockVersion: parameters.blockVersion ?? bv };
  return {
    tx: parseTransaction(hexToBytes(e.tx_bytes_hex), blockVersionContext(bv)),
    deps: {
      inputBoxes: e.input_boxes_hex.map(parseBox),
      dataInputBoxes: e.data_input_boxes_hex.map(parseBox),
      stateContext: {
        headers: e.headers_hex.map((h) => parseHeader(new ByteReader(hexToBytes(h)))),
        preHeader: {
          version: ph.version, parentId: hexToBytes(ph.parentId), timestamp: BigInt(ph.timestamp),
          nBits: ph.nBits, height: ph.height, minerPk: hexToBytes(ph.minerPk), votes: hexToBytes(ph.votes),
        },
        parameters: effective,
      },
    },
  };
}
